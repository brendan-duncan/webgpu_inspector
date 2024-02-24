import { Button } from "./widget/button.js";
import { Collapsable } from "./widget/collapsable.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Widget } from "./widget/widget.js";
import { getFlagString } from "../utils/flags.js";
import { CaptureStatistics } from "./capture_statistics.js";
import { NumberInput } from "./widget/number_input.js";
import {
  Sampler,
  TextureView
} from "./gpu_objects/index.js";
import { decodeDataUrl } from "../utils/base64.js";
import { Actions, PanelActions } from "../utils/actions.js";

export class CapturePanel {
  constructor(window, parent) {
    this.window = window;

    const self = this;
    const port = window.port;

    this.statistics = new CaptureStatistics();

    const controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    new Button(controlBar, { label: "Capture", style: "background-color: #557;", callback: () => { 
      try {
        self.port.postMessage({ action: PanelActions.Capture, maxBufferSize: self.maxBufferSize });
      } catch (e) {}
    } });

    this.maxBufferSize = (1024 * 1024) / 4;
    new Span(controlBar, { text: "Max Buffer Size (Bytes):", style: "margin-left: 10px; margin-right: 5px; vertical-align: middle; color: #bbb;" });
    new NumberInput(controlBar, { value: this.maxBufferSize, min: 1, step: 1, precision: 0, style: "display: inline-block; width: 100px; margin-right: 10px; vertical-align: middle;", onChange: (value) => {
      self.maxBufferSize = Math.max(value, 1);
    } });

    new Span(controlBar, {  style: "" });

    this._captureFrame = new Span(controlBar, { style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
    this._captureStats = new Button(controlBar, { label: "Frame Stats", style: "display: none;" });
    this._captureStatus = new Span(controlBar, { style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });

    this._capturePanel = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-100px + 100vh); display: flex;" });

    window.onTextureLoaded.addListener(this._textureLoaded, this);
    window.onTextureDataChunkLoaded.addListener(this._textureDataChunkLoaded, this);

    this._loadingImages = 0;
    this._loadingBuffers = 0;
    this._loadedDataChunks = 0;

    this._captureCommands = [];
    this._catpureFrameIndex = 0;
    this._captureCount = 0;
    this._lastSelectedCommand = null;
    this._capturedObjects = new Map();
    this._frameImageList = [];
    this._gpuTextureMap = new Map();
    this._passEncoderCommands = new Map();

    port.addListener((message) => {
      switch (message.action) {
        case Actions.CaptureTextureFrames: {
          self._loadedDataChunks += message.chunkCount;
          self._loadingImages += message.count ?? 0;
          const textures = message.textures;
          if (textures) {
            for (const textureId of textures) {
              const texture = self._getObject(textureId);
              if (texture) {
                texture.imageDataPending = true;
              }
            }
          }
          self._updateCaptureStatus();
          break;
        }
        case Actions.CaptureFrameResults: {
          const frame = message.frame;
          const count = message.count;
          const batches = message.batches;
          self._captureCommands.length = count;
          self._catpureFrameIndex = frame;
          self._captureCount = batches;
          break;
        }
        case Actions.CaptureFrameCommands: {
          const commands = message.commands;
          const index = message.index;
          const count = message.count;
          const frame = message.frame;
          for (let i = 0, j = index; i < count; ++i, ++j) {
            self._captureCommands[j] = commands[i];
          }
          self._captureCount--;
          if (self._captureCount === 0) {
            self._captureFrameResults(frame, self._captureCommands);
          }
          break;
        }
        case Actions.CaptureBuffers: {
          self._loadingBuffers += message.count ?? 0;
          self._loadedDataChunks += message.chunkCount;
          self._updateCaptureStatus();
          break;
        }
        case Actions.CaptureBufferData: {
          const id = message.commandId;
          const entryIndex = message.entryIndex;
          const offset = message.offset;
          const size = message.size;
          const index = message.index;
          const count = message.count;
          const chunk = message.chunk;
          self._captureBufferData(id, entryIndex, offset, size, index, count, chunk);
          break;
        }
      }
    });
  }

  _clampedTextureWidth(texture) {
    return Math.max(Math.min(Math.max(texture.width, texture.height), 256), 64);
  }

  _getObject(id) {
    return this._capturedObjects.get(id) ?? this.database.getObject(id);
  }

  _captureBufferData(id, entryIndex, offset, size, index, count, chunk) {
    if (id < 0 || id > this._captureCommands.length || id?.constructor !== Number) {
      return;
    }
    const command = this._captureCommands[id];
    if (!command) {
      return;
    }

    if (!command.bufferData) {
      command.bufferData = [];
    }

    if (!command.dataPending) {
      command.dataPending = [];
    }

    if (!command.bufferData[entryIndex]) {
      command.bufferData[entryIndex] = new Uint8Array(size);
      command.dataPending[entryIndex] = true;
    }

    const bufferData = command.bufferData[entryIndex];
    
    if (bufferData.length != size) {
      return;
    }

    if (!command.loadedDataChunks) {
      command.loadedDataChunks = [];
    }

    if (!command.loadedDataChunks[entryIndex]) {
      command.loadedDataChunks[entryIndex] = [];
    }

    if (command.loadedDataChunks[entryIndex].length !== count) {
      command.loadedDataChunks[entryIndex].length = count;
    }

    if (!command.isBufferDataLoaded) {
      command.isBufferDataLoaded = [];
    }

    const self = this;
    decodeDataUrl(chunk).then((chunkData) => {
      self._loadedDataChunks--;
      try {
        command.bufferData[entryIndex].set(chunkData, offset);
        command.loadedDataChunks[entryIndex][index] = true;
      } catch (e) {
        console.log(e);
        command.loadedDataChunks[entryIndex].length = 0;
        command.isBufferDataLoaded[entryIndex] = false;
      }

      let loaded = true;
      for (let i = 0; i < count; ++i) {
        if (!command.loadedDataChunks[entryIndex][i]) {
          loaded = false;
          break;
        }
      }
      command.isBufferDataLoaded[entryIndex] = loaded;

      if (command.isBufferDataLoaded[entryIndex]) {     
        self._loadingBuffers--;
        command.loadedDataChunks[entryIndex].length = 0;
      }
      self._updateCaptureStatus();
    });
  }

  _updateCaptureStatus() {
    let text = "";
    if (this._loadingImages || this._loadingBuffers || this._loadedDataChunks) {
      text = "Loading ";

      if (this._loadingImages) {
        text += `Images: ${this._loadingImages} `;
      }
      if (this._loadingBuffers) {
        text += `Buffers: ${this._loadingBuffers} `;
      }
      if (this._loadedDataChunks) {
        text += `Data Chunks: ${this._loadedDataChunks} `;
      }
    }
    this._captureStatus.text = text;
  }

  get database() {
    return this.window.database;
  }

  get port() {
    return this.window.port;
  }

  get textureUtils() {
    return this.window.textureUtils;
  }

  _processCommandArgs(object) {
    if (!object) {
      return object;
    }
    if (object.__id !== undefined) {
      const obj = this._getObject(object.__id);
      if (obj) {
        return `${obj.constructor.className} ID:${object.__id}`;
      }
      return `${object.__class || "Object"}.${object.__id}`;
    }
    if (object instanceof Array) {
      const newArray = [];
      for (const i in object) {
        newArray[i] = this._processCommandArgs(object[i]);
      }
      return newArray;
    }
    if (object instanceof Object) {
      const newObject = {};
      for (const key in object) {
        newObject[key] = this._processCommandArgs(object[key]);
      }
      return newObject;
    }
    return object;
  }

  _captureFrameResults(frame, commands) {
    const contents = this._capturePanel;

    this._captureFrame.text = `Frame ${frame}`;
    this._captureStats.style.display = "inline-block";

    contents.html = "";

    this._capturedObjects.clear();
    this._frameImageList.length = 0;
    this._passEncoderCommands.clear();

    this._gpuTextureMap.forEach((value) => {
      value.removeReference();
    });
    this._gpuTextureMap.clear();

    this._frameImages = new Span(contents, { class: "capture_frameImages" });
    const frameContents = new Span(contents, { class: "capture_frame" });
    const commandInfo = new Span(contents, { class: "capture_commandInfo" });

    const self = this;
    this._captureStats.callback = () => {
      self._inspectStats(commandInfo);
    };

    const debugGroupStack = [frameContents];
    const debugGroupLabelStack = [];
    let debugGroupIndex = 0;

    let currentBlock = new Div(frameContents, { class: "capture_commandBlock" });

    this._lastSelectedCommand = null;

    const stats = this.statistics;
    stats.reset();

    const passEncoderMap = new Map();

    // Pass index is based on end, not begin, so we need to prepare the pass index map first.
    let renderPassIndex = 0;
    let computePassIndex = 0;
    for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
      const command = commands[commandIndex];
      const method = command.method;
      if (method === "beginRenderPass") {
        passEncoderMap.set(command.result, -1);
      } else if (method === "beginComputePass") {
        passEncoderMap.set(command.result, -2);
      } else if (method === "end") {
        const type = passEncoderMap.get(command.object);
        if (type === -1) {
          passEncoderMap.set(command.object, renderPassIndex++);
        } else if (type === -2) {
          passEncoderMap.set(command.object, computePassIndex++);
        }
      }
    }

    let first = true;
    for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
      const command = commands[commandIndex];
      if (!command) {
        break;
      }
      const className = command.class;
      const method = command.method;
      const args = command.args;
      const name = `${className ?? "__"}`;

      stats.updateStats(this.database, className, method, args);

      let debugGroup = debugGroupStack[debugGroupStack.length - 1];

      if (method === "beginRenderPass") {
        const passIndex = passEncoderMap.get(command.result);

        this._passEncoderCommands.set(command.result, [command]);

        command._passIndex = passIndex;
        currentBlock = new Div(debugGroup, { class: "capture_renderpass" });

        const header = new Div(currentBlock, { id: `RenderPass_${passIndex}`, class: "capture_renderpass_header" });
        new Span(header, { text: `Render Pass ${passIndex}` });
        const extra = new Span(header, { style: "margin-left: 10px;" });
        const block = new Div(currentBlock)
        header.element.onclick = () => {
          block.element.classList.toggle("collapsed");
          if (block.element.classList.contains("collapsed")) {
            extra.text = "...";
          } else {
            extra.text = "";
          }
        };
        currentBlock = block;
        currentBlock._passIndex = passIndex;

        for (const attachment of args[0].colorAttachments) {
          const textureView = this._getTextureViewFromAttachment(attachment);
          if (textureView) {
            this._capturedObjects.set(textureView.id, textureView);
            const texture = this.database.getTextureFromView(textureView);
            if (texture) {
              this._capturedObjects.set(texture.id, texture);
            }
          }
        }

        if (args[0].depthStencilAttachment) {
          const textureView = this._getTextureViewFromAttachment(args[0].depthStencilAttachment);
          if (textureView) {
            this._capturedObjects.set(textureView.id, textureView);
            const texture = this.database.getTextureFromView(textureView);
            if (texture) {
              this._capturedObjects.set(texture.id, texture);
            }
          }
        }
      } else if (method === "beginComputePass") {
        const passIndex = passEncoderMap.get(command.result);

        this._passEncoderCommands.set(command.result, [command]);

        command._passIndex = passIndex;
        currentBlock = new Div(debugGroup, { class: "capture_computepass" });
        const header = new Div(currentBlock, { id: `ComputePass_${passIndex}`, class: "capture_computepass_header" });
        new Span(header, { text: `Compute Pass ${passIndex}` });
        const extra = new Span(header, { style: "margin-left: 10px;" });
        const block = new Div(currentBlock);
        header.element.onclick = () => {
          block.element.classList.toggle("collapsed");
          if (block.element.classList.contains("collapsed")) {
            extra.text = "...";
          } else {
            extra.text = "";
          }
        };
        currentBlock = block;
        currentBlock._passIndex = passIndex;
      } else if (method === "popDebugGroup") {
        debugGroupStack.pop();
        debugGroup = debugGroupStack[debugGroupStack.length - 1];
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      } else {
        const object = command.object;
        const commandArray = this._passEncoderCommands.get(object);
        if (commandArray) {
          commandArray.push(command);
        }

        if (passEncoderMap.has(object)) {
          const passIndex = passEncoderMap.get(object);
          if (currentBlock._passIndex !== passIndex) {
            currentBlock = new Div(debugGroup, { class: "capture_renderpass" });
            const header = new Div(currentBlock, { id: `RenderPass_${passIndex}`, class: "capture_renderpass_header" });
            new Span(header, { text: `Render Pass ${passIndex}` });
            const extra = new Span(header, { style: "margin-left: 10px;" });
            const block = new Div(currentBlock)
            header.element.onclick = () => {
              block.element.classList.toggle("collapsed");
              if (block.element.classList.contains("collapsed")) {
                extra.text = "...";
              } else {
                extra.text = "";
              }
            };
            currentBlock = block;
            currentBlock._passIndex = passIndex;
          }
        }
      }

      const cmdType = ["capture_command"];
      if (method === "draw" || method === "drawIndexed" || method === "drawIndirect" || method === "drawIndexedIndirect" ||
          method === "dispatchWorkgroups" || method == "dispatchWorkgroupsIndirect") {
        cmdType.push("capture_drawcall");
      }

      const cmd = new Div(currentBlock, { class: cmdType });
      if (method === "end") {
        cmd.element.id = `Pass_${currentBlock._passIndex}_end`;
      } else if (method === "beginRenderPass") {
        cmd.element.id = `RenderPass_${currentBlock._passIndex}_begin`;
      }

      new Span(cmd, { class: "capture_callnum", text: `${commandIndex}.` });

      const self = this;

      function getName(id, className) {
        const obj = self._getObject(id);
        if (obj) {
          return obj.label || `${obj.name}(${obj.idName})`;
        }
        return id ?
          className ?
            `${className}(${id})` :
            `${id}` :
          "";
      }
      
      new Span(cmd, { class: "capture_methodName", text: `${method}` });

      if (method === "createCommandEncoder") {
        new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUCommandEncoder")}` });
      } else if (method === "finish") {
        new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)}` });
      } if (method === "getMappedRange") {
        new Span(cmd, { class: "capture_method_args", text: getName(command.object) });
      } else if (method === "unmap") {
        new Span(cmd, { class: "capture_method_args", text: getName(command.object) });
      } else if (method === "copyBufferToBuffer") {
        new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0].__id)} srcOffset:${args[1]} dest:${getName(args[2].__id)} destOffset:${args[3]} size:${args[4]}` });
      } else if (method === "clearBuffer") {
        new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0].__id)} offset:${args[1]} size:${args[4]}` });
      } else if (method === "copyBufferToTexture") {
        new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0].buffer.__id)} texture:${getName(args[1].texture.__id)}` });
      } else if (method === "copyTextureToBuffer") {
        new Span(cmd, { class: "capture_method_args", text: `texture:${getName(args[0].texture.__id)} buffer:${getName(args[1].buffer.__id)}` });
      } else if (method === "copyTextureToTexture") {
        new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0].texture.__id)} dest:${getName(args[1].texture.__id)}` });
      } else if (method === "setViewport") {
        new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]} minZ:${args[4]} maxZ:${args[5]}` });
      } else if (method === "setScissorRect") {
        new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]}` });
      } else if (method === "setStencilReference") {
        new Span(cmd, { class: "capture_method_args", text: `reference:${args[0]}` });
      } else if (method === "setBindGroup") {
        new Span(cmd, { class: "capture_method_args", text: `index:${args[0]} bindGroup:${getName(args[1].__id)}` });
        const bg = this._getObject(args[1].__id);
        if (bg) {
          this._capturedObjects.set(args[1].__id, bg);
          for (const entry of bg.descriptor.entries) {
            if (entry.resource?.__id) {
              const obj = this._getObject(entry.resource.__id);
              this._capturedObjects.set(entry.resource.__id, obj);
              if (obj instanceof TextureView) {
                const tex = this._getObject(obj.texture?.id ?? obj.texture);
                if (tex) {
                  this._capturedObjects.set(tex.id, tex);
                }
              }
            } else if (entry.resource?.buffer?.__id) {
              const obj = this._getObject(entry.resource.buffer.__id);
              this._capturedObjects.set(entry.resource.buffer.__id, obj);
            }
          }
        }
      } else if (method === "writeBuffer") {
        const data = args[2];
        if (data.constructor === String) {
          const s = data.split(" ")[2];
          new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0].__id)} offset:${args[1]} data:${s} Bytes` });
        } else {
          new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0].__id)} offset:${args[1]} data:${args[2].length} Bytes` });
        }
      } else if (method === "setPipeline") {
        new Span(cmd, { class: "capture_method_args", text: `renderPipeline:${getName(args[0].__id)}` });
        this._capturedObjects.set(args[0].__id, this._getObject(args[0].__id));
      } else if (method === "setVertexBuffer") {
        new Span(cmd, { class: "capture_method_args", text: `slot:${args[0]} buffer:${getName(args[1].__id)} offset:${args[2] ?? 0}` });
        this._capturedObjects.set(args[1].__id, this._getObject(args[1].__id));
      } else if (method === "setIndexBuffer") {
        new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0].__id)} indexFormat:${args[1]} offset:${args[2] ?? 0}` });
        this._capturedObjects.set(args[0].__id, this._getObject(args[0].__id));
      } else if (method === "drawIndexed") {
        new Span(cmd, { class: "capture_method_args", text: `indexCount:${args[0]} instanceCount:${args[1] ?? 1} firstIndex:${args[2] ?? 0} baseVertex:${args[3] ?? 0} firstInstance:${args[4] ?? 0}` });
      } else if (method === "draw") {
        new Span(cmd, { class: "capture_method_args", text: `vertexCount:${args[0]} instanceCount:${args[1] ?? 1} firstVertex:${args[2] ?? 0} firstInstance:${args[3] ?? 0}` });
      } else if (method === "dispatchWorkgroups") {
        new Span(cmd, { class: "capture_method_args", text: `countX:${args[0]} countY:${args[1] ?? 1} countZ:${args[2] ?? 1}` });
      } else if (method === "dispatchWorkgroupsIndirect") {
        new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${getName(args[0].__id)} offset:${args[1]}` });
      } else if (method === "pushDebugGroup") {
        new Span(cmd, { class: "capture_method_args", text: args[0] });
        debugGroupLabelStack.push(args[0]);
      } else if (method === "popDebugGroup") {
        const label = debugGroupLabelStack.pop();
        new Span(cmd, { class: "capture_method_args", text: label });
      } else if (method === "createView") {
        new Span(cmd, { class: "capture_method_args", text: `${getName(command.object)} => ${getName(command.result, "GPUTextureView")}` });
      } else if (method === "beginRenderPass") {
        new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPURenderPassEncoder")}` });
      } else if (method === "beginComputePass") {
        new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPUComputePassEncoder")}` });
      } else if (method === "end") {
        new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)}` });
      } else if (method === "createBuffer") {
        new Span(cmd, { class: "capture_method_args", text: `size:${args[0].size} usage:${args[0].usage} mappedAtCreation:${args[0].mappedAtCreation ?? false} => ${getName(command.result, "GPUBuffer")}` });
      } else if (method === "writeTexture") {
        new Span(cmd, { class: "capture_method_args", text: `dest:${getName(args[0].texture.__id)}` });
      } else if (method === "destroy") {
        new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)}` });
      } else if (method === "getCurrentTexture") {
        new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUTexture")}` });
      } else if (method === "submit") {
        let buffers = "[";
        for (const buffer of args[0]) {
          buffers += `${getName(buffer.__id)}, `;
        }
        buffers += "]";
        new Span(cmd, { class: "capture_method_args", text: `=> ${buffers}` });
      }

      cmd.element.onclick = () => {
        if (self._lastSelectedCommand !== cmd) {
          if (self._lastSelectedCommand) {
            self._lastSelectedCommand.classList.remove("capture_command_selected");
          }
          cmd.classList.add("capture_command_selected");
          self._lastSelectedCommand = cmd;
        }
        
        self._showCaptureCommandInfo(command, name, commandInfo);
      };

      if (first) {
        // Start off selecting the first command.
        cmd.element.click();
        first = false;
      }

      if (method === "pushDebugGroup") {
        const grp = new Div(debugGroup, { text: `Debug Group: ${args[0]}`, id: `DebugGroup_${debugGroupIndex}`,  class: "capture_debugGroup" });
        debugGroupStack.push(grp);
        debugGroupIndex++;
        debugGroup = grp;

        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      }

      if (method === "end") {
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      }
    }
  }

  _getTextureViewFromAttachment(attachment) {
    if (!attachment) {
      return null;
    }
    if (attachment.resolveTarget) {
      return this._getObject(attachment.resolveTarget.__id);
    }
    return this._getObject(attachment.view?.__id);
  }

  _getTextureFromAttachment(attachment) {
    if (!attachment) {
      return null;
    }
    if (attachment.resolveTarget) {
      if (attachment.resolveTarget?.__texture?.__id) {
        return this._getObject(attachment.resolveTarget.__texture.__id);
      }
    } else {
      if (attachment.view?.__texture?.__id) {
        return this._getObject(attachment.view.__texture.__id);
      }
    }
    const view = this._getTextureViewFromAttachment(attachment);
    if (!view) {
      return null;
    }

    return this.database.getTextureFromView(view);
  }

  _createTextureWidget(parent, texture, passId, size, style) {
    const gpuTexture = this._gpuTextureMap.get(passId) ?? texture.gpuTexture;

    // Only supportting 2d previews for now
    if (texture.dimension !== "2d") {
      return;
    }

    let viewWidth = 0;
    let viewHeight = 0;
    if (size) {
      if (texture.width > texture.height) {
        viewWidth = size;
        viewHeight = Math.round(viewWidth * (texture.height / texture.width));
      } else {
        viewHeight = size;
        viewWidth = Math.round(viewHeight * (texture.width / texture.height));
      }
    }

    const container = new Div(parent);
    
    const numLayers = texture.depthOrArrayLayers;
    for (let layer = 0; layer < numLayers; ++layer) {
      const canvas = new Widget("canvas", new Div(container), { style });
      canvas.element.width = texture.width;
      canvas.element.height = texture.height;

      if (viewWidth) {
        canvas.element.style.width = `${viewWidth}px`;
        canvas.element.style.height = `${viewHeight}px`;
      }

      const layerView = gpuTexture.object.createView({
        dimension: "2d",
        baseArrayLayer: layer,
        layerArrayCount: 1
      });

      const context = canvas.element.getContext("webgpu");
      const dstFormat = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ "device": this.window.device, "format": navigator.gpu.getPreferredCanvasFormat() });
      const canvasTexture = context.getCurrentTexture();
      this.textureUtils.blitTexture(layerView, texture.format, 1, canvasTexture.createView(), dstFormat);
    }

    return container;
  }

  _showCaptureCommandInfo_beginRenderPass(command, commandInfo) {
    const renderPassIndex = command._passIndex;
    const args = command.args;
    const self = this;
    const colorAttachments = args[0].colorAttachments;
    for (let i = 0, l = colorAttachments.length; i < l; ++i) {
      const attachment = colorAttachments[i];
      const texture = this._getTextureFromAttachment(attachment);
      if (texture) {
        const format = texture.descriptor.format;
        if (texture.gpuTexture) {
          const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: Texture:${texture.idName} ${format} ${texture.resolutionString}` });
          new Button(colorAttachmentGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(texture);
          } });
          const passId = this._getPassId(renderPassIndex, i);
          this._createTextureWidget(colorAttachmentGrp.body, texture, passId, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
        } else {
          const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: ${format} ${texture.resolutionString}` });
          new Button(colorAttachmentGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(texture);
          } });
          new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(attachment.view.descriptor, undefined, 4) });
          const texDesc = this._processCommandArgs(texture.descriptor);
          if (texDesc.usage) {
            texDesc.usage = getFlagString(texDesc.usage, GPUTextureUsage);
          }
          new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(texDesc, undefined, 4) });
        }
      }
    }

    const depthStencilAttachment = args[0].depthStencilAttachment;
    if (depthStencilAttachment) {
      const texture = this._getTextureFromAttachment(depthStencilAttachment);
      if (texture) {
        if (texture.gpuTexture) {
          const format = texture.descriptor.format;
          const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment ${format} ${texture.resolutionString}` });
          new Button(depthStencilAttachmentGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(texture);
          } });
          this._createTextureWidget(depthStencilAttachmentGrp.body, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
        } else {
          const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment: ${texture?.format ?? "<unknown format>"} ${texture.resolutionString}` });
          new Button(depthStencilAttachmentGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(texture);
          } });
          new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(depthStencilAttachment.view.descriptor, undefined, 4) });
          const texDesc = this._processCommandArgs(texture.descriptor);
          if (texDesc.usage) {
            texDesc.usage = getFlagString(texDesc.usage, GPUTextureUsage);
          }
          new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(texDesc, undefined, 4) });
        }
      }
    }
  }

  _showBufferDataType(ui, type, bufferData, offset = 0) {
    if (!type) {
      return;
    }

    const typeName = this._getTypeName(type);

    if (typeName === "f32") {
      const data = new Float32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${data[0]}`});
    } else if (typeName === "i32") {
      const data = new Int32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${data[0]}`});
    } else if (typeName === "u32") {
      const data = new Uint32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${data[0]}`});
    } else if (typeName === "bool") {
      const data = new Uint32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${data[0] ? "true" : "false"}`});
    } else if (typeName === "vec2i" || typeName === "vec2<i32>") {
      const data = new Int32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}`});
    } else if (typeName === "vec2u" || typeName === "vec2<u32>") {
      const data = new Uint32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}`});
    } else if (typeName === "vec2f" || typeName === "vec2<f32>") {
      const data = new Float32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}`});
    } else if (typeName === "vec3i" || typeName === "vec3<i32>") {
      const data = new Int32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}, ${data[2]}`});
    } else if (typeName === "vec3u" || typeName === "vec3<u32>") {
      const data = new Uint32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}, ${data[2]}`});
    } else if (typeName === "vec3f" || typeName === "vec3<f32>") {
      const data = new Float32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}, ${data[2]}`});
    } else if (typeName === "vec4i" || typeName === "vec4<i32>") {
      const data = new Int32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}, ${data[2]}, ${data[3]}`});
    } else if (typeName === "vec4u" || typeName === "vec4<u32>") {
      const data = new Uint32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}, ${data[2]}, ${data[3]}`});
    } else if (typeName === "vec4f" || typeName === "vec4<f32>") {
      const data = new Float32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${data[0]}, ${data[1]}, ${data[2]}, ${data[3]}`});
    } else if (CapturePanel.matrixTypes[type.name]) {
      const t = CapturePanel.matrixTypes[type.name];
      const rows = t.rows;
      const columns = t.columns;
      const data = new Float32Array(bufferData.buffer, offset, rows * columns);
      for (let r = 0, mi = 0; r < rows; ++r) {
        let text = "";
        for (let c = 0; c < columns; ++c, ++mi) {
          text += `${c == 0 ? "" : " "}${data[mi]}`;
        }
        new Widget("li", ui, { text });
      }
    } else if (type.members) {
      const l2 = new Widget("ul", ui);
      for (const m of type.members) {
        const typeName = this._getTypeName(m.type);
        new Widget("li", l2, { text: `${m.name}: ${typeName}` });
        const l3 = new Widget("ul", l2);
        this._showBufferDataType(l3, m.type, bufferData, offset + m.offset);
      }
    } else if (type.name === "array") {
      const ul = new Widget("ul", ui);
      let count = type.count ?? 0;
      if (count == 0) {
        // Runtime length array
        count = (bufferData.length - offset) / (type.stride || 1);
      }
      if (count) {
        let elementOffset = offset;
        let stride = type.stride;
        let format = type.format;
        for (let i = 0; i < count; ++i) { 
          new Widget("li", ul, { text: `[${i}]: ${this._getTypeName(format)}` });
          const ul2 = new Widget("ul", ul);
          this._showBufferDataType(ul2,format, bufferData, elementOffset);
          elementOffset += stride;
        }
      }
    }
  }

  _showBufferDataInfo(parentWidget, module, groupIndex, bindingIndex, bufferData) {
    const reflection = module.reflection;
    if (!reflection) {
      return;
    }

    for (const uniform of reflection.uniforms) {
      if (uniform.group != groupIndex || uniform.binding != bindingIndex) {
        continue;
      }
      const typeName = this._getTypeName(uniform.type);
      new Div(parentWidget, { text: `UNIFORM: ${uniform.name}: ${typeName}` });
      this._showBufferDataType(parentWidget, uniform.type, bufferData);
      return;
    }

    for (const storage of reflection.storage) {
      if (storage.group != groupIndex || storage.binding != bindingIndex) {
        continue;
      }
      const typeName = this._getTypeName(storage.type);
      new Div(parentWidget, { text: `STORAGE ${storage.access}: ${storage.name}: ${typeName}` });
      this._showBufferDataType(parentWidget, storage.type, bufferData);
      return;
    }
  }

  _showBufferData(parentWidget, groupIndex, entryIndex, bindGroup, state, bufferData) {
    new Div(parentWidget, { text: `Bind Group ${groupIndex} Binding ${entryIndex} size: ${bufferData.length}` });

    const id = state.pipeline?.args[0].__id;
    const pipeline = this._getObject(id);

    if (pipeline) {
      const desc = pipeline.descriptor;
      const vertexId = desc.vertex?.module?.__id;
      const fragmentId = desc.fragment?.module?.__id;
      const computeId = desc.compute?.module?.__id;
      if (computeId) {
        const module = this._getObject(computeId);
        if (module) {
          this._showBufferDataInfo(parentWidget, module, groupIndex, entryIndex, bufferData);
        }
      } else if (vertexId !== undefined && vertexId === fragmentId) {
        const module = this._getObject(vertexId);
        if (module) {
          this._showBufferDataInfo(parentWidget, module, groupIndex, entryIndex, bufferData);
        }
      } else {
        const vertexModule = this._getObject(vertexId);
        if (vertexModule) {
          this._showBufferDataInfo(parentWidget, vertexModule, groupIndex, entryIndex, bufferData);
        }

        const fragmentModule = this._getObject(fragmentId);
        if (fragmentModule) {
          this._showBufferDataInfo(parentWidget, fragmentModule, groupIndex, entryIndex, bufferData);
        }
      }
    }
  }

  _showCaptureCommandInfo_setBindGroup(command, commandInfo, groupIndex, skipInputs, state) {
    const args = command.args;
    const id = args[1].__id;
    const bindGroup = this._getObject(id);
    if (!bindGroup) {
      return;
    }

    const self = this;

    const group = args[0];
    const bindGroupGrp = new Collapsable(commandInfo, { collapsed: true, label: `BindGroup ${groupIndex ?? ""} ID:${id}` });
    new Button(bindGroupGrp.body, { label: "Inspect", callback: () => {
      self.window.inspectObject(bindGroup);
    } });

    const bindGroupDesc = bindGroup.descriptor;
    const newDesc = this._processCommandArgs(bindGroupDesc);
    const descStr = JSON.stringify(newDesc, undefined, 4);
    new Widget("pre", bindGroupGrp.body, { text: descStr });

    function getResourceType(resource) {
      if (resource.__id !== undefined) {
        const obj = self._getObject(resource.__id);
        if (obj) {
          return obj.constructor.className;
        }
      }
      if (resource.buffer) {
        return "Buffer";
      }
      if (resource.__class) {
        return resource.__class;
      }
      return "<unknown resource type>";
    }

    function getResourceId(resource) {
      if (resource.__id !== undefined) {
        return resource.__id;
      }
      if (resource.buffer?.__id !== undefined) {
        return resource.buffer.__id;
      }
      return 0;
    }

    function getResourceUsage(resource) {
      if (resource.buffer) {
        const buffer = self._getObject(resource.buffer.__id);
        if (buffer) {
          const usage = buffer.descriptor.usage & GPUBufferUsage.UNIFORM ? "Uniform" :
                buffer.descriptor.usage & GPUBufferUsage.STORAGE ? "Storage" :
                "";
          return usage;
        }
      }
      return "";
    }

    if (!skipInputs) {
      const inputs = [];    
      if (bindGroup?.entries) {
        for (const entry of bindGroup.entries) {
          if (entry.resource?.__id) {
            const resource = this._getObject(entry.resource.__id);
            if (resource instanceof TextureView) {
              const binding = entry.binding;
              inputs.push({textureView: resource, group, binding });
            }
          }
        }
      }

      if (inputs.length) {
        const inputGrp = new Collapsable(commandInfo, { collapsed: true, label: "Input Textures" });
        for (const resource of inputs) {
          const texture = this.database.getTextureFromView(resource.textureView);
          if (texture) {
            new Button(inputGrp.body, { label: "Inspect", callback: () => {
              self.window.inspectObject(texture);
            } });
            if (texture.gpuTexture) {
              const canvasDiv = new Div(inputGrp.body);
              new Div(canvasDiv, { text: `Group: ${resource.group} Binding: ${resource.binding} Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
              this._createTextureWidget(canvasDiv, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
            } else {
              this.database.requestTextureData(texture);
            }
          }
        }
      }
    }

    const bindGroupCmd = state?.bindGroups[groupIndex];  

    for (const entryIndex in bindGroupDesc.entries) {
      const entry = bindGroupDesc.entries[entryIndex];

      const binding = entry.binding;
      const resource = entry.resource;
      const groupLabel = groupIndex !== undefined ? `Group ${groupIndex} ` : "";

      let access = "";
      if (state) {
        const pipelineId = state.pipeline?.args[0].__id;
        const pipeline = this._getObject(pipelineId);
        if (pipeline) {
          const desc = pipeline.descriptor;
          const vertexId = desc.vertex?.module?.__id;
          const fragmentId = desc.fragment?.module?.__id;
          const computeId = desc.compute?.module?.__id;
          if (computeId) {
            const module = this._getObject(computeId);
            if (module) {
              const reflection = module.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == groupIndex && storage.binding == binding) {
                    access = storage.access;
                    break;
                  }
                }
              }
            }
          } else if (vertexId !== undefined && vertexId === fragmentId) {
            const module = this._getObject(vertexId);
            if (module) {
              const reflection = module.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == groupIndex && storage.binding == binding) {
                    access = storage.access;
                    break;
                  }
                }
              }
            }
          } else {
            const vertexModule = this._getObject(vertexId);
            if (vertexModule) {
              const reflection = vertexModule.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == groupIndex && storage.binding == binding) {
                    access = storage.access;
                    break;
                  }
                }
              }
            }

            const fragmentModule = this._getObject(fragmentId);
            if (fragmentModule) {
              const reflection = fragmentModule.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == groupIndex && storage.binding == binding) {
                    access = storage.access;
                    break;
                  }
                }
              }
            }
          }
        }
      }

      const resourceGrp = new Collapsable(commandInfo, { collapsed: true, label: `${groupLabel}Binding ${binding}: ${getResourceType(resource)} ID:${getResourceId(resource)} ${getResourceUsage(resource)} ${access}` });
      if (resource.__id !== undefined) {
        const obj = this._getObject(resource.__id);
        if (obj) {
          new Button(resourceGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(obj);
          } });

          if (obj instanceof Sampler) {
            new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
          } else if (obj instanceof TextureView) {
            const texture = this._getObject(obj.texture);

            new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
            if (texture) {
              new Div(resourceGrp.body, { text: `GPUTexture ID:${texture.idName}` });
              const newDesc = this._processCommandArgs(texture.descriptor);
              if (newDesc.usage) {
                newDesc.usage = getFlagString(newDesc.usage, GPUTextureUsage);
              }
              new Widget("pre", resourceGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
            
              if (texture.gpuTexture) {
                const w = Math.max(Math.min(texture.width, texture.height, 256), 64);
                this._createTextureWidget(resourceGrp.body, texture, -1, w, "margin-left: 20px; margin-top: 10px; margin-bottom: 10px;");
              }
            }
          } else {
            new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
          }
        } else {
          new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
        }
      } else {
        if (resource.buffer) {
          const bufferId = resource.buffer.__id;
          const buffer = this._getObject(bufferId);
          if (buffer) {
            new Button(resourceGrp.body, { label: "Inspect", callback: () => {
              self.window.inspectObject(buffer);
            } });
            const bufferDesc = buffer.descriptor;
            const newDesc = this._processCommandArgs(bufferDesc);
            if (newDesc.usage) {
              newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
            }
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
          } else {
            new Div(resourceGrp.body, { text: `Buffer ID:${bufferId}` });
          }

          if (bindGroupCmd?.isBufferDataLoaded) {
            if (bindGroupCmd.isBufferDataLoaded[entryIndex]) {
              const bufferData = bindGroupCmd.bufferData[entryIndex];
              if (bufferData) {
                this._showBufferData(resourceGrp.body, groupIndex, binding, bindGroup, state, bufferData);
              }
            }
          }
        } else {
          new Widget("pre", resourceGrp.body, { text: JSON.stringify(resource, undefined, 4) });
        }
      }
    }
  }

  _showCaptureCommandInfo_setPipeline(command, commandInfo) {
    const args = command.args;
    const self = this;
    const id = args[0].__id;
    const pipeline = this._getObject(id);

    if (pipeline) {
      const pipelineGrp = new Collapsable(commandInfo, { collapsed: true, label: `Pipeline ID:${id}` });
      new Button(pipelineGrp.body, { label: "Inspect", callback: () => {
        self.window.inspectObject(pipeline);
      } });
      const desc = pipeline.descriptor;
      const newDesc = this._processCommandArgs(desc);
      const descStr = JSON.stringify(newDesc, undefined, 4);
      new Widget("pre", pipelineGrp.body, { text: descStr });

      const vertexId = desc.vertex?.module?.__id;
      const fragmentId = desc.fragment?.module?.__id;

      if (vertexId !== undefined && vertexId === fragmentId) {
        const module = this._getObject(vertexId);
        if (module) {
          const vertexEntry = desc.vertex?.entryPoint;
          const fragmentEntry = desc.fragment?.entryPoint;
          const grp = new Collapsable(commandInfo, { collapsed: true, label: `Module ID:${vertexId} Vertex: ${vertexEntry} Fragment: ${fragmentEntry}` });
          new Button(grp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(module);
          } });
          const code = module.descriptor.code;
          new Widget("pre", grp.body, { text: code });

          this._shaderInfo("Vertex+Fragment", module, commandInfo);
        }
      } else {
        if (vertexId !== undefined) {
          const vertexModule = this._getObject(vertexId);
          if (vertexModule) {
            const vertexEntry = desc.vertex?.entryPoint;
            const vertexGrp = new Collapsable(commandInfo, { collapsed: true, label: `Vertex Module ID:${vertexId} Entry: ${vertexEntry}` });
            new Button(vertexGrp.body, { label: "Inspect", callback: () => {
              self.window.inspectObject(vertexModule);
            } });
            const code = vertexModule.descriptor.code;
            new Widget("pre", vertexGrp.body, { text: code });

            this._shaderInfo("Vertex", vertexModule, commandInfo);
          }
        }
        
        if (fragmentId !== undefined) {
          const fragmentModule = this._getObject(fragmentId);
          if (fragmentModule) {
            const fragmentEntry = desc.fragment?.entryPoint;
            const fragmentGrp = new Collapsable(commandInfo, { collapsed: true, label: `Fragment Module ID:${fragmentId} Entry: ${fragmentEntry}` });
            new Button(fragmentGrp.body, { label: "Inspect", callback: () => {
              self.window.inspectObject(fragmentModule);
            } });
            const code = fragmentModule.descriptor.code;
            new Widget("pre", fragmentGrp.body, { text: code });

            this._shaderInfo("Fragment", fragmentModule, commandInfo);
          }
        }
      }

      const computeId = desc.compute?.module?.__id;
      if (computeId !== undefined) {
        const computeModule = this._getObject(computeId);
        if (computeModule) {
          const computeEntry = desc.compute?.entryPoint;
          const computeGrp = new Collapsable(commandInfo, { collapsed: true, label: `Compute Module ID:${computeId} Entry: ${computeEntry}` });
          new Button(computeGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(computeModule);
          } });
          const code = computeModule.descriptor.code;
          new Widget("pre", computeGrp.body, { text: code });

          this._shaderInfo("Compute", computeModule, commandInfo);
        }
      }
    }
  }

  _showCaptureCommandInfo_writeBuffer(command, commandInfo) {
    const args = command.args;
    const id = args[0].__id;
    const buffer = this._getObject(id);

    if (buffer) {
      const bufferGrp = new Collapsable(commandInfo, { label: `Buffer ID:${id}` });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
    }
  }

  _showCaptureCommandInfo_setIndexBuffer(command, commandInfo, collapsed) {
    const args = command.args;
    const self = this;
    const id = args[0].__id;
    const buffer = this._getObject(id);
    if (buffer) {
      const bufferGrp = new Collapsable(commandInfo, { collapsed, label: `Index Buffer ID:${id}` });
      new Button(bufferGrp.body, { label: "Inspect", callback: () => {
        self.window.inspectObject(buffer);
      } });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
    }
  }

  _showCaptureCommandInfo_setVertexBuffer(command, commandInfo, collapsed) {
    const args = command.args;
    const self = this;
    const index = args[0];
    const id = args[1]?.__id;
    const buffer = this._getObject(id);
    if (buffer) {
      const bufferGrp = new Collapsable(commandInfo, { collapsed, label: `Vertex Buffer ${index} ID:${id}` });
      new Button(bufferGrp.body, { label: "Inspect", callback: () => {
        self.window.inspectObject(buffer);
      } });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
    }
  }

  _getPipelineState(command) {
    const commands = this._passEncoderCommands.get(command.object);
    const commandIndex = commands.indexOf(command);
    if (commandIndex === -1) {
      return null;
    }
    
    let pipeline = null;
    let vertexBuffers = [];
    let indexBuffer = null;
    let bindGroups = [];
    let renderPass = null;
    let computePass = null;
    for (let ci = commandIndex - 1; ci >= 0; --ci) {
      const cmd = commands[ci];
      if (cmd.method === "beginRenderPass") {
        renderPass = cmd;
        break;
      }
      if (cmd.method === "beginComputePass") {
        computePass = cmd;
        break;
      }
      if (cmd.method === "setIndexBuffer" && !indexBuffer) {
        indexBuffer = cmd;
      }
      if (cmd.method === "setVertexBuffer") {
        const index = cmd.args[0];
        if (!vertexBuffers[index]) {
          vertexBuffers[index] = cmd;
        }
      }
      if (cmd.method === "setPipeline" && !pipeline) {
        pipeline = cmd;
      }
      if (cmd.method === "setBindGroup") {
        const bindGroupIndex = cmd.args[0];
        if (!bindGroups[bindGroupIndex]) {
          bindGroups[bindGroupIndex] = cmd;
        }
      }
    }

    return { renderPass, computePass, pipeline, vertexBuffers, indexBuffer, bindGroups };
  }

  _getTypeName(t) {
    if (t.format) {
      if (t.name === "array" && t.count) {
        return `${t.name}<${t.format.name}, ${t.count}>`
      }
      return `${t.name}<${t.format.name}>`
    }
    return t.name;
  }

  _addShaderTypeInfo(ui, type) {
    if (!type) {
      return;
    }
    if (type.members) {
      new Widget("li", ui, { text: `Members:` });
      const l2 = new Widget("ul", ui);
      for (const m of type.members) {
        new Widget("li", l2, { text: `${m.name}: ${this._getTypeName(m.type)}` });
        const l3 = new Widget("ul", l2);
        new Widget("li", l3, { text: `Offset: ${m.offset}` });
        new Widget("li", l3, { text: `Size: ${m.size || "<runtime>"}` });

        this._addShaderTypeInfo(l3, m.type.format);
      }
    } else if (type.name === "array") {
      this._addShaderTypeInfo(type.format);
    }
  }

  _shaderInfoEntryFunction(ui, entry) {
    new Widget("li", ui, { text: `Entry: ${entry.name}` });
    if (entry.inputs.length) {
      new Widget("li", ui, { text: `Inputs: ${entry.inputs.length}` });
      const l2 = new Widget("ul", ui);
      for (const s of entry.inputs) {
        new Widget("li", l2, { text: `@${s.locationType}(${s.location}) ${s.name}: ${this._getTypeName(s.type)} ${s.interpolation || ""}` });
      }
    }
    if (entry.outputs.length) {
      new Widget("li", ui, { text: `Outputs: ${entry.outputs.length}` });
      const l2 = new Widget("ul", ui);
      for (const s of entry.outputs) {
        new Widget("li", l2, { text: `@${s.locationType}(${s.location}) ${s.name}: ${this._getTypeName(s.type)}` });
      }
    }
  }

  _shaderInfo(type, shader, commandInfo) {
    const reflect = shader.reflection;
    if (reflect) {
      const grp = new Collapsable(commandInfo, { collapsed: true, label: `${type} Shader Info` });

      if (reflect.entry.vertex.length) {
        new Div(grp.body, { text: `Vertex Entry Functions: ${reflect.entry.vertex.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.entry.vertex) {
          this._shaderInfoEntryFunction(list, s);
        }
      }

      if (reflect.entry.fragment.length) {
        new Div(grp.body, { text: `Fragment Entry Functions: ${reflect.entry.fragment.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.entry.fragment) {
          this._shaderInfoEntryFunction(list, s);
        }
      }

      if (reflect.entry.compute.length) {
        new Div(grp.body, { text: `Compute Entry Functions: ${reflect.entry.compute.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.entry.compute) {
          this._shaderInfoEntryFunction(list, s);
        }
      }
      
      if (reflect.uniforms.length) {
        new Div(grp.body, { text: `Uniform Buffers: ${reflect.uniforms.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.uniforms) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
          new Widget("li", l2, { text: `Size: ${s.type.size || "<runtime>"}` });
          
          this._addShaderTypeInfo(l2, s.type);
        }
      }

      if (reflect.storage.length) {
        new Div(grp.body, { text: `Storage Buffers: ${reflect.storage.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.storage) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
          new Widget("li", l2, { text: `Access: ${s.access}` });
          new Widget("li", l2, { text: `Size: ${s.type.size || "<runtime>"}` });

          this._addShaderTypeInfo(l2, s.type);
        }
      }
      
      if (reflect.textures.length) {
        new Div(grp.body, { text: `Textures: ${reflect.textures.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.textures) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
        }
      }

      if (reflect.samplers.length) {
        new Div(grp.body, { text: `Samplers: ${reflect.samplers.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.samplers) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
        }
      }
    }
  }

  _showTextureOutputs(state, parent, collapsed) {
    let renderPassIndex = 0;
    const outputs = { color: [], depthStencil: null };
    if (state.renderPass) {
      renderPassIndex = state.renderPass._passIndex;
      const renderPass = state.renderPass.args[0];
      if (renderPass?.colorAttachments) {
        for (const attachment of renderPass.colorAttachments) {
          const texture = this._getTextureFromAttachment(attachment);
          outputs.color.push(texture);
        }
      }
      if (renderPass?.depthStencilAttachment) {
        const texture = this._getTextureFromAttachment(renderPass.depthStencilAttachment);
        outputs.depthStencil = texture;
      }
    }

    if (outputs.color.length || outputs.depthStencil) {
      const self = this;
      const outputGrp = new Collapsable(parent, { collapsed, label: "Output Textures" });
      for (let index = 0, l = outputs.color.length; index < l; ++index) {
        const texture = outputs.color[index];
        const passId = this._getPassId(renderPassIndex, index);
        if (texture) {
          new Button(outputGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(texture);
          } });
          if (texture.gpuTexture) {
            const canvasDiv = new Div(outputGrp.body);
            new Div(canvasDiv, { text: `Color: ${index} Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this._createTextureWidget(canvasDiv, texture, passId, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
          } else {
            new Div(outputGrp.body, { text: `Color: ${index} Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this.database.requestTextureData(texture);
          }
        }
      }

      if (outputs.depthStencil) {
        const texture = outputs.depthStencil;
        if (texture) {
          new Button(outputGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(texture);
          } });
          if (texture.gpuTexture) {
            const canvasDiv = new Div(outputGrp.body);
            new Div(canvasDiv, { text: `DepthStencil Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this._createTextureWidget(canvasDiv, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
          } else {
            new Div(outputGrp.body, { text: `DepthStencil Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this.database.requestTextureData(texture);
          }
        }
      }
    }
  }

  _showTextureInputs(state, parent) {
    const inputs = [];
    for (const bindGroupCmd of state.bindGroups) {
      const group = bindGroupCmd.args[0];
      const bindGroup = this._getObject(bindGroupCmd.args[1]?.__id);
      if (bindGroup?.entries) {
        for (const entry of bindGroup.entries) {
          if (entry.resource?.__id) {
            const resource = this._getObject(entry.resource.__id);
            if (resource instanceof TextureView) {
              const binding = entry.binding;
              inputs.push({textureView: resource, group, binding });
            }
          }
        }
      }
    }

    if (inputs.length) {
      const self = this;
      const inputGrp = new Collapsable(parent, { collapsed: true, label: "Input Textures" });
      for (const resource of inputs) {
        const texture = this.database.getTextureFromView(resource.textureView);
        if (texture) {
          new Button(inputGrp.body, { label: "Inspect", callback: () => {
            self.window.inspectObject(texture);
          } });
          if (texture.gpuTexture) {
            const canvasDiv = new Div(inputGrp.body);
            new Div(canvasDiv, { text: `Group: ${resource.group} Binding: ${resource.binding} Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this._createTextureWidget(canvasDiv, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
          } else {
            this.database.requestTextureData(texture);
          }
        }
      }
    }
  }

  _showCaptureCommandInfo_end(command, commandInfo) {
    const state = this._getPipelineState(command);
    this._showTextureOutputs(state, commandInfo, false);
  }

  _showCaptureCommandInfo_draw(command, commandInfo) {
    const state = this._getPipelineState(command);

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  _showCaptureCommandInfo_drawIndexed(command, commandInfo) {
    const state = this._getPipelineState(command);

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    if (state.indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  _showCaptureCommandInfo_drawIndirect(command, commandInfo) {
    const state = this._getPipelineState(command);

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  _showCaptureCommandInfo_drawIndexedIndirect(command, commandInfo) {
    const state = this._getPipelineState(command);

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    if (state.indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  _showCaptureCommandInfo_dispatchWorkgroups(command, commandInfo) {
    const state = this._getPipelineState(command);
    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  _showCaptureCommandInfo_createView(command, commandInfo) {
    const texture = this._getObject(command.object);
    if (!texture) {
      return;
    }

    const self = this;
    const inputGrp = new Collapsable(commandInfo, { collapsed: false, label: `Texture ${texture.idName} ${texture.format} ${texture.resolutionString}` });
    new Button(inputGrp.body, { label: "Inspect", callback: () => {
      self.window.inspectObject(texture);
    } });
    if (texture.gpuTexture) {
      const canvasDiv = new Div(inputGrp.body);
      this._createTextureWidget(canvasDiv, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
    } else {
      this.database.requestTextureData(texture);
    }
  }

  _inspectStats(commandInfo) {
    commandInfo.html = "";

    const group = new Collapsable(commandInfo, { label: "Frame Statistics" });

    const ol = new Widget("ul", group.body);
    const stats = this.statistics;
    for (const key in stats) {
      new Widget("li", ol, { text: `${key}: ${stats[key].toLocaleString("en-US")}`, style: "padding-left: 20px; line-height: 25px; font-size: 12pt;" });
    }
  }

  _showCaptureCommandInfo(command, name, commandInfo) {
    commandInfo.html = "";

    const method = command.method;
    const args = command.args;

    new Div(commandInfo, { text: `${name} ${method}`, style: "background-color: #575; padding-left: 20px; line-height: 40px;" });

    if (method === "beginRenderPass") {
      const desc = args[0];
      const colorAttachments = desc.colorAttachments;
      for (const i in colorAttachments) {
        const attachment = colorAttachments[i];
        const texture = this._getTextureFromAttachment(attachment);
        if (texture) {
          const format = texture.descriptor.format;
          new Div(commandInfo, { text: `Color ${i}: ${format} ${texture.resolutionString}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        }
      }
      const depthStencilAttachment = desc.depthStencilAttachment;
      if (depthStencilAttachment) {
        const texture = this._getTextureFromAttachment(depthStencilAttachment);
        if (texture) {
          const format = texture.descriptor.format;
          new Div(commandInfo, { text: `Depth-Stencil: ${format} ${texture.resolutionString}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        }
      }
    } else if (method === "draw" || method === "drawIndexed") {
      const state = this._getPipelineState(command);
      if (state.pipeline) {
        const topology = this._getObject(state.pipeline.args[0].__id)?.topology ?? "triangle-list";
        const vertexCount = args[0] ?? 0;
        if (topology === "triangle-list") {
          const count = (vertexCount / 3).toLocaleString("en-US");
          new Div(commandInfo, { text: `Triangles: ${count}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        } else if (topology === "triangle-strip") {
          const count = (vertexCount - 2).toLocaleString("en-US");
          new Div(commandInfo, { text: `Triangles: ${count}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        } else if (topology === "point-list") {
          const count = (vertexCount).toLocaleString("en-US");
          new Div(commandInfo, { text: `Points: ${count}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        } else if (topology === "line-list") {
          const count = (vertexCount / 2).toLocaleString("en-US");
          new Div(commandInfo, { text: `Lines: ${count}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        } else if (topology === "line-strip") {
          const count = (vertexCount - 1).toLocaleString("en-US");
          new Div(commandInfo, { text: `Lines: ${count}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        }
      }
    }

    if (command.stacktrace) {
      const stacktrace = new Collapsable(commandInfo, { collapsed: true, label: "Stacktrace" });
      new Div(stacktrace.body, { text: command.stacktrace, style: "font-size: 10pt;color: #ddd;overflow: auto;background-color: rgb(51, 51, 85);box-shadow: #000 0 3px 5px;padding: 5px;padding-left: 10px;" })
    }

    const argsGroup = new Collapsable(commandInfo, { label: "Arguments" });
    const newArgs = this._processCommandArgs(args);
    if (CapturePanel._commandArgs[method]) {
      const args = CapturePanel._commandArgs[method];
      for (let i = 0, l = newArgs.length; i < l; ++i) {
        const arg = args[i];
        const value = newArgs[i];
        const valueStr = value instanceof Array ? `[${value.length}]: ${value}` : JSON.stringify(value, undefined, 4);
        if (arg !== undefined) {
          new Widget("pre", argsGroup.body, { text: `${arg}: ${valueStr}`, style: "margin-left: 10px;" });
        } else {
          new Widget("pre", argsGroup.body, { text: `[${i}]: ${valueStr}`, style: "margin-left: 10px;" });
        }
      }
    } else {
      new Widget("pre", argsGroup.body, { text: JSON.stringify(newArgs, undefined, 4) });
    }

    if (method == "beginRenderPass") {
      this._showCaptureCommandInfo_beginRenderPass(command, commandInfo);
    } else if (method === "setBindGroup") {
      this._showCaptureCommandInfo_setBindGroup(command, commandInfo, 0, false);
    } else if (method === "setPipeline") {
      this._showCaptureCommandInfo_setPipeline(command, commandInfo);
    } else if (method === "writeBuffer") {
      this._showCaptureCommandInfo_writeBuffer(command, commandInfo);
    } else if (method === "setIndexBuffer") {
      this._showCaptureCommandInfo_setIndexBuffer(command, commandInfo);
    } else if (method === "setVertexBuffer") {
      this._showCaptureCommandInfo_setVertexBuffer(command, commandInfo);
    } else if (method === "drawIndexed") {
      this._showCaptureCommandInfo_drawIndexed(command, commandInfo);
    } else if (method === "draw") {
      this._showCaptureCommandInfo_draw(command, commandInfo);
    } else if (method === "drawIndirect") {
      this._showCaptureCommandInfo_drawIndirect(command, commandInfo);
    } else if (method === "drawIndexedIndirect") {
      this._showCaptureCommandInfo_drawIndexedIndirect(command, commandInfo);
    } else if (method === "dispatchWorkgroups") {
      this._showCaptureCommandInfo_dispatchWorkgroups(command, commandInfo);
    } else if (method === "end") {
      this._showCaptureCommandInfo_end(command, commandInfo);
    } else if (method === "createView") {
      this._showCaptureCommandInfo_createView(command, commandInfo);
    }
  }

  _textureDataChunkLoaded() {
    this._loadedDataChunks--;
    this._updateCaptureStatus();
  }

  _findCanvas(widget) {
    if (widget.element.tagName === "CANVAS") {
      return widget;
    }
    for (const child of widget.children) {
      const canvas = this._findCanvas(child);
      if (canvas) {
        return canvas;
      }
    }
    return null;
  }

  _getPassId(renderPass, attachment) {
    return renderPass * 10 + attachment;
  }

  _getPassIdCanvas(passId) {
    const passFrame = this._frameImageList[passId];
    if (!passFrame) {
      return null;
    }
    return this._findCanvas(passFrame);
  }

  _textureLoaded(texture, passId) {
    if (this._lastSelectedCommand) {
      this._lastSelectedCommand.element.click();
    }

    this._loadingImages--;
    this._updateCaptureStatus();

    const frameImages = this._frameImages;
    if (passId != -1 && frameImages) {
      const passIdValue = passId / 10;
      const passIndex = Math.floor(passIdValue);
      const attachment = passId - (passIndex * 10);

      let passFrame = null;

      if (passId >= this._frameImageList.length) {
        passFrame = new Div(frameImages, { class: "capture_pass_texture" });
        this._frameImageList[passId] = passFrame;
      } else {
        passFrame = new Div(null, { class: "capture_pass_texture" });
        let found = false;
        for (let i = passId - 1; i >= 0; --i) {
          if (this._frameImageList[i]) {
            frameImages.insertAfter(passFrame, this._frameImageList[i]); // This needs to be an insertAfter
            found = true;
            break;
          }
        }
        if (!found) {
          frameImages.insertBefore(passFrame, frameImages.children[0]);
        }
        this._frameImageList[passId] = passFrame;
      }

      new Div(passFrame, { text: `Render Pass ${passIndex} ${`Attachment ${attachment}`}`, style: "color: #ddd; margin-bottom: 5px;" });
      const textureId = texture.id < 0 ? "CANVAS" : texture.id;
      new Div(passFrame, { text: `${texture.name} ID:${textureId}`, style: "color: #ddd; margin-bottom: 10px;" });
      new Div(passFrame, { text: `${texture.format} ${texture.resolutionString}`, style: "color: #ddd; margin-bottom: 10px; font-size: 9pt;" });

      this._createTextureWidget(passFrame, texture, passId, 256);

      this._gpuTextureMap.set(passId, texture.gpuTexture)
      texture.gpuTexture.addReference();

      passFrame.element.onclick = () => {
        const element = document.getElementById(`RenderPass_${passIndex}`);
        if (element) {
          element.scrollIntoView();
          const beginElement = document.getElementById(`RenderPass_${passIndex}_begin`);
          if (beginElement) {
            beginElement.click();
          }
        }
      };
    }
  }
}

CapturePanel.matrixTypes = {
  "mat2x2": { columns: 2, rows: 2 },
  "mat2x2f": { columns: 2, rows: 2 },
  "mat2x3": { columns: 2, rows: 3 },
  "mat2x3f": { columns: 2, rows: 3 },
  "mat2x4": { columns: 2, rows: 4 },
  "mat2x4f": { columns: 2, rows: 4 },
  
  "mat3x2": { columns: 3, rows: 2 },
  "mat3x2f": { columns: 3, rows: 2 },
  "mat3x3": { columns: 3, rows: 3 },
  "mat3x3f": { columns: 3, rows: 3 },
  "mat3x4": { columns: 3, rows: 4 },
  "mat3x4f": { columns: 3, rows: 4 },

  "mat4x2": { columns: 4, rows: 2 },
  "mat4x2f": { columns: 4, rows: 2 },
  "mat4x3": { columns: 4, rows: 3 },
  "mat4x3f": { columns: 4, rows: 3 },
  "mat4x4": { columns: 4, rows: 4 },
  "mat4x4f": { columns: 4, rows: 4 }
};

CapturePanel._commandArgs = {
  "beginComputePass": ["descriptor"],
  "beginOcclusionQuery": ["queryIndex"],
  "beginRenderPass": ["descriptor"],
  "configure": ["configuration"],
  "clearBuffer": ["buffer", "offset", "size"],
  "copyBufferToBuffer": ["source", "sourceOffset", "destination", "destinationOffset", "size"],
  "copyBufferToTexture": ["source", "destination", "copySize"],
  "copyTextureToBuffer": ["source", "destination", "copySize"],
  "copyTextureToTexture": ["source", "destination", "copySize"],
  "createBindGroup": ["descriptor"],
  "createBindGroupLayout": ["descriptor"],
  "createBuffer": ["descriptor"],
  "createCommandEncoder": ["descriptor"],
  "createComputePipeline": ["descriptor"],
  "createComputePipelineAsync": ["descriptor"],
  "createPipelineLayout": ["descriptor"],
  "createQuerySet": ["descriptor"],
  "createRenderBundleEncoder": ["descriptor"],
  "createRenderPipeline": ["descriptor"],
  "createRenderPipelineAsync": ["descriptor"],
  "createSampler": ["descriptor"],
  "createShaderModule": ["descriptor"],
  "createTexture": ["descriptor"],
  "createView": ["descriptor"],
  "destroy": [],
  "dispatchWorkgroups": ["workgroupCountX", "workgroupCountY", "workgroupCountZ"],
  "dispatchWorkgroupsIndirect": ["indirectBuffer", "indirectOffset"],
  "draw": ["vertexCount", "instanceCount", "firstVertex", "firstInstance"],
  "drawIndexed": ["indexCount", "instanceCount", "firstIndex", "baseVertex", "firstInstance"],
  "drawIndirect": ["indirectBuffer", "indirectOffset"],
  "drawIndexedIndirect": ["indirectBuffer", "indirectOffset"],
  "end": [],
  "endOcclusionQuery": [],
  "executeBundles": ["bundles"],
  "finish": ["descriptor"],
  "getCompilationInfo": [],
  "getCurrentTexture": [],
  "getMappedRange": ["offset", "size"],
  "importExternalTexture": ["descriptor"],
  "insertDebugMarker": ["markerLabel"],
  "mapAsync": ["mode", "offset", "size"],
  "onSubmittedWorkDone": ["workDonePromise", "callback"],
  "pushDebugGroup": ["groupLabel"],
  "popDebugGroup": [],
  "resolveQuerySet": ["querySet", "firstQuery", "queryCount", "destination", "destinationOffset"],
  "setBindGroup": ["index", "bindGroup", "dynamicOffsets"],
  "setBlendColor": ["color"],
  "setIndexBuffer": ["buffer", "indexFormat", "offset", "size"],
  "setVertexBuffer": ["slot", "buffer", "offset", "size"],
  "setPipeline": ["pipeline"],
  "setScissorRect": ["x", "y", "width", "height"],
  "setStencilReference": ["reference"],
  "setViewport": ["x", "y", "width", "height", "minDepth", "maxDepth"],
  "submit": ["commandBuffers"],
  "unmap": [],
  "writeBuffer": ["buffer", "bufferOffset", "data", "dataOffset", "size"],
  "writeTexture": ["destination", "data", "dataLayout", "size", "bytesPerRow"],
  "copyExternalImageToTexture": ["source", "destination", "copySize"],
};
