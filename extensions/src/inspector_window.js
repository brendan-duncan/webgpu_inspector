import { decodeBase64 } from "./base64.js";
import { Button } from "./widget/button.js";
import { Div } from "./widget/div.js";
import { Input } from "./widget/input.js";
import { Span } from "./widget/span.js";
import { Widget } from "./widget/widget.js";
import { Window } from "./widget/window.js";
import { TabWidget } from "./widget/tab_widget.js";
import { TextureFormatInfo } from "./texture_format_info.js";
import { TextureUtils } from "./texture_utils.js";
import { Adapter,
  Device,
  Buffer,
  Sampler,
  Texture,
  TextureView,
  ShaderModule,
  BindGroupLayout,
  PipelineLayout,
  BindGroup,
  RenderPipeline,
  ComputePipeline } from "./object_database.js";
import { Collapsable } from "./widget/collapsable.js";

export class InspectorWindow extends Window {
  constructor(database, port) {
    super();

    this.port = port;
    this.database = database
    this.classList.add("main-window");
    this._selectedObject = null;
    this._inspectedObject = null;

    this.adapter = null;
    this.device = null;

    this._tabs = new TabWidget(this);

    const inspectorPanel = new Div(null, { class: "inspector_panel" });
    this._tabs.addTab("Inspect", inspectorPanel);

    const capturePanel = new Div(null, { class: "capture_panel" });
    this._tabs.addTab("Capture", capturePanel);

    const recorderPanel = new Div(null, { class: "recorder_panel" });
    this._tabs.addTab("Record", recorderPanel);

    this._buildInspectorPanel(inspectorPanel);
    this._buildRecorderPanel(recorderPanel);
    this._buildCapturePanel(capturePanel);

    this._resetInspectorPanel();

    this.database.onEndFrame.addListener(this._updateFrameStats, this);
    this.database.onAddObject.addListener(this._addObject, this);
    this.database.onDeleteObject.addListener(this._deleteObject, this);
    this.database.onObjectLabelChanged.addListener(this._objectLabelChanged, this);
  }

  async initialize() {
    if (!navigator.gpu) {
      return;
    }
    this.adapter = await navigator.gpu.requestAdapter();
    if (!this.adapter) {
      return;
    }

    const features = [];
    const limits = {};
    for (const key of this.adapter.features) {
      features.push(key);
    }
    const exclude = new Set(["minSubgroupSize", "maxSubgroupSize"]);
    for (const key in this.adapter.limits) {
      if (!exclude.has(key)) {
        limits[key] = this.adapter.limits[key];
      }
    }

    this.device = await this.adapter.requestDevice({requiredFeatures: features, requiredLimits: limits});

    this.textureUtils = new TextureUtils(this.device);
  }

  _buildInspectorPanel(inspectorPanel) {
    const self = this;
    const controlBar = new Div(inspectorPanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; font-size: 10pt;" });

    this.inspectButton = new Button(controlBar, { label: "Start", callback: () => { 
      try {
        self.database.reset();
        self._resetInspectorPanel();
        self.port.postMessage({ action: "initialize_inspector" });
      } catch (e) {}
    } });

    const stats = new Span(controlBar, { style: "border-left: 1px solid #aaa; padding-left: 10px; margin-left: 20px; height: 20px; padding-top: 5px; color: #ddd;" });
    this.uiFrameTime = new Span(stats);
    this.uiFrameRenderPasses = new Span(stats, { style: "margin-left: 20px;" });
    this.uiTotalTextureMemory = new Span(stats, { style: "margin-left: 20px;" });
    this.uiTotalBufferMemory = new Span(stats, { style: "margin-left: 20px;" });

    this.inspectorGUI = new Div(inspectorPanel, { style: "overflow: hidden; white-space: nowrap; height: calc(-85px + 100vh); display: flex;" });
  }

  _buildCapturePanel(capturePanel) {
    const self = this;

    const controlBar = new Div(capturePanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    new Button(controlBar, { label: "Capture", style: "background-color: #557;", callback: () => { 
      try {
        self.port.postMessage({ action: "inspector_capture" });
      } catch (e) {}
    } });

    this._captureFrame = new Span(controlBar, { text: ``, style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });

    this._capturePanel = new Div(capturePanel, { style: "overflow: hidden; white-space: nowrap; height: calc(-100px + 100vh); display: flex;" });
  }

  _buildRecorderPanel(recorderPanel) {
    const self = this;
    const port = this.port;

    const recorderBar = new Div(recorderPanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 5px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; width: calc(-60px + 100vw);" });

    this.recordButton = new Button(recorderBar, { label: "Record", style: "background-color: #755;", callback: () => {
      const frames = self.recordFramesInput.value || 1;
      const filename = self.recordNameInput.value;
      self._recordingData.length = 0;
      self.port.postMessage({ action: "initialize_recorder", frames, filename });
    }});

    new Span(recorderBar, { text: "Frames:", style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
    this.recordFramesInput = new Input(recorderBar, { id: "record_frames", type: "number", value: 100 });

    new Span(recorderBar, { text: "Name:", style: "margin-left: 20px; margin-right: 10px;  vertical-align: middle;" });
    this.recordNameInput = new Input(recorderBar, { id: "record_frames", type: "text", value: "webgpu_record" });

    this._recordingData = [];

    this.recorderDataPanel = new Div(recorderPanel);

    port.addListener((message) => {
      switch (message.action) {
        case "webgpu_recording": {
          if (message.index !== undefined && message.count !== undefined && message.data !== undefined) {
            self._addRecordingData(message.data, message.index, message.count);
          }
          break;
        }
        case "inspect_capture_frame_results": {
          const commands = message.commands;
          const frame = message.frame;
          self._captureFrameResults(frame, commands);
          break;
        }
        case "inspect_capture_texture_data": {
          const id = message.id;
          const passId = message.passId;
          const offset = message.offset;
          const size = message.size;
          const index = message.index;
          const count = message.count;
          const chunk = message.chunk;
          self._captureTextureData(id, passId, offset, size, index, count, chunk);
          break;
        }
      }
    });
  }

  _processCommandArgs(object) {
    if (!object) {
      return object;
    }
    if (object.__id !== undefined) {
      const obj = this.database.getObject(object.__id);
      if (obj) {
        return `${obj.constructor.name} ID:${object.__id}`;
      }
      return `&${object.__id} ${object.__class || "Object"}`;
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

  _captureTextureData(id, passId, offset, size, index, count, chunk) {
    const object = this.database.getObject(id);
    if (!object || !(object instanceof Texture)) {
      return;
    }

    if (object.loadedImageDataChunks.length != count) {
      object.loadedImageDataChunks.length = count;
      object.isImageDataLoaded = false;
    }

    object.loadedImageDataChunks[index] = 1;

    if (!(object.imageData instanceof Uint8Array) || (object.imageData.length != size)) {
      object.imageData = new Uint8Array(size);
    }

    const data = decodeBase64(chunk);

    try {
      object.imageData.set(data, offset);
    } catch (e) {
      console.log("TEXTURE IMAGE DATA SET ERROR", id, passId, offset, data.length, object.imageData.length);
      object.loadedImageDataChunks.length = 0;
      object.isImageDataLoaded = false;
    }

    let loaded = true;
    for (let i = 0; i < count; ++i) {
      if (!object.loadedImageDataChunks[i]) {
        loaded = false;
        break;
      }
    }
    object.isImageDataLoaded = loaded;

    if (object.isImageDataLoaded) {
      object.loadedImageDataChunks.length = 0;
      this._createTexture(object, passId);
    }
  }

  _createTexture(texture, passId) {
    const usage = texture.descriptor.usage;
    const format = texture.descriptor.format;
    const formatInfo = TextureFormatInfo[format] ?? TextureFormatInfo["rgba8unorm"];

    // For depth textures we can't currently use writeTexture.
    // To load data into a depth texture, put the imageData into a storage buffer
    // then do a blit where the shader reads from the storage buffer and writes
    // to frag_depth. On the webgpu_inspector side, we should translate imageData
    // from depth24plus to depth32 so we can deal with floats and not weird depth24
    // data.

    // For now, we can't preview depth-stencil textures.
    if (formatInfo.isDepthStencil) {
      return;
    }

    const gpuFormat = formatInfo.depthOnlyFormat ?? format;
    texture.descriptor.format = gpuFormat;
    texture.descriptor.usage = (usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.TEXTURE_BINDING;
    texture.gpuTexture = this.device.createTexture(texture.descriptor);
    texture.descriptor.usage = usage;
    texture.descriptor.format = format;
    
    const width = texture.width;
    const texelByteSize = formatInfo.bytesPerBlock;
    const bytesPerRow = (width * texelByteSize + 255) & ~0xff;
    const rowsPerImage = texture.height;

    this.device.queue.writeTexture(
      {
        texture: texture.gpuTexture
      },
      texture.imageData,
      {
        offset: 0,
        bytesPerRow,
        rowsPerImage
      },
      texture.descriptor.size);

    if (this._inspectedObject == texture) {
      this._inspectObject(texture);
    }

    if (passId == -1) {
      return;
    }

    const frameImages = this._frameImages;
    if (frameImages) {
      const aspect = texture.height / texture.width;
      const viewWidth = 256;
      const viewHeight = Math.round(viewWidth * aspect);

      const passFrame = new Div(frameImages, { class: "capture_pass_texture" });

      new Div(passFrame, { text: `Render Pass ${passId}`, style: "color: #ddd; margin-bottom: 5px;" });
      const textureId = texture.id < 0 ? "CANVAS" : texture.id;
      new Div(passFrame, { text: `${texture.name} ID:${textureId}`, style: "color: #ddd; margin-bottom: 10px;" })
      
      const canvas = new Widget("canvas", passFrame);
      canvas.element.width = viewWidth;
      canvas.element.height = viewHeight;
      const context = canvas.element.getContext('webgpu');
      const dstFormat = navigator.gpu.getPreferredCanvasFormat();
      context.configure({"device":this.device, "format":navigator.gpu.getPreferredCanvasFormat()});
      const canvasTexture = context.getCurrentTexture();
      this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);

      canvas.element.onclick = () => {
        const element = document.getElementById(`RenderPass_${passId}`);
        if (element) {
          element.scrollIntoView();

          const beginElement = document.getElementById(`RenderPass_${passId}_begin`);
          if (beginElement) {
            beginElement.click();
          }
        }
      };
    }
  }

  _captureFrameResults(frame, commands) {
    const contents = this._capturePanel;

    this._captureFrame.text = `Frame ${frame}`;

    contents.html = "";   

    this._frameImages = new Span(contents, { class: "capture_frameImages" });
    const frameContents = new Span(contents, { class: "capture_frame" });
    const commandInfo = new Span(contents, { class: "capture_commandInfo" });
    
    let currentPass = new Div(frameContents, { class: "capture_commandBlock" });
    let renderPassIndex = 0;

    this._lastSelectedCommand = null;

    let first = true;
    for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
      const command = commands[commandIndex];
      const className = command.class;
      const method = command.method;
      const args = command.args;
      const name = `${className ?? "__"}`;

      if (method == "beginRenderPass") {
        currentPass = new Div(frameContents, { class: "capture_renderpass" });
        new Div(currentPass, { text: `Render Pass ${renderPassIndex}`, id: `RenderPass_${renderPassIndex}`, style: "padding-left: 20px; font-size: 12pt; color: #ddd; margin-bottom: 5px; background-color: #553; line-height: 30px;" });
        renderPassIndex++;
      } else if (method == "beginComputePass") {
        currentPass = new Div(frameContents, { class: "capture_computepass" });
      }

      const cmdType = ["capture_command"];
      if (method == "draw" || method == "drawIndexed" || method == "drawIndirect" || method == "drawIndexedIndirect") {
        cmdType.push("capture_drawcall");
      }

      const cmd = new Div(currentPass, { class: cmdType });
      if (method == "beginRenderPass") {
        cmd.element.id = `RenderPass_${renderPassIndex - 1}_begin`;
      }
      new Span(cmd, { class: "capture_callnum", text: `${commandIndex}.` });
      new Span(cmd, { class: "capture_methodName", text: `${method}` });

      if (method === "setViewport") {
        new Span(cmd, { class: "capture_method_args", text: `${args[0]}, ${args[1]}, ${args[2]}, ${args[3]}, ${args[4]}, ${args[5]}` });
      } else if (method === "setScissorRect") {
        new Span(cmd, { class: "capture_method_args", text: `${args[0]}, ${args[1]}, ${args[2]}, ${args[3]}` });
      } else if (method === "setBindGroup") {
        new Span(cmd, { class: "capture_method_args", text: `${args[0]}` });
      }

      const self = this;
      cmd.element.onclick = () => {
        if (self._lastSelectedCommand !== cmd) {
          if (self._lastSelectedCommand) {
            self._lastSelectedCommand.classList.remove("capture_command_selected");
          }
          cmd.classList.add("capture_command_selected");
          self._lastSelectedCommand = cmd;
        }
        
        self._showCaptureCommandInfo(name, method, args, commandInfo, commandIndex, commands);
      };

      if (first) {
        // Start off selecting the first command.
        cmd.element.click();
        first = false;
      }

      if (method == "end") {
        currentPass = new Div(frameContents, { class: "capture_commandBlock" });
      }
    }
  }

  _showCaptureCommandInfo_beginRenderPass(args, commandInfo) {
    const colorAttachments = args[0].colorAttachments;
    for (const i in colorAttachments) {
      const attachment = colorAttachments[i];
      const texture = attachment.view.__id
          ? this.database.getObject(attachment.view.__id).parent
          : attachment.view.__texture
              ? this.database.getObject(attachment.view.__texture.__id)
              : null;
        const format = texture.descriptor.format;
      if (texture && texture.gpuTexture) {
        const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: ${format}` });

        const viewWidth = 256;
        const viewHeight = Math.round(viewWidth * (texture.height / texture.width));
        const canvas = new Widget("canvas", colorAttachmentGrp, { style: "margin-left: 20px; margin-top: 10px;" });
        canvas.element.width = viewWidth;
        canvas.element.height = viewHeight;
        const context = canvas.element.getContext('webgpu');
        const dstFormat = navigator.gpu.getPreferredCanvasFormat();
        context.configure({"device":this.device, "format":navigator.gpu.getPreferredCanvasFormat()});
        const canvasTexture = context.getCurrentTexture();
        this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
      } else {
        const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: ${format}` });
        new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(depthStencilAttachment.view.descriptor, undefined, 4) });
        const texDesc = this._processCommandArgs(texture.descriptor);
        if (texDesc.usage) {
          texDesc.usage = this._getFlagString(texDesc.usage, GPUTextureUsage);
        }
        new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(texDesc, undefined, 4) });
      }
    }
    const depthStencilAttachment = args[0].depthStencilAttachment;
    if (depthStencilAttachment) {
      const texture = depthStencilAttachment.view.__id
          ? this.database.getObject(depthStencilAttachment.view.__id).parent
          : depthStencilAttachment.view.__texture
              ? this.database.getObject(depthStencilAttachment.view.__texture.__id)
              : null;
      if (texture && texture.gpuTexture) {
        const format = texture.descriptor.format;
        const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment ${format}` });
        const viewWidth = 256;
        const viewHeight = Math.round(viewWidth * (texture.height / texture.width));
        const canvas = new Widget("canvas", depthStencilAttachmentGrp, { style: "margin-left: 20px; margin-top: 10px;" });
        canvas.element.width = viewWidth;
        canvas.element.height = viewHeight;
        const context = canvas.element.getContext('webgpu');
        const dstFormat = navigator.gpu.getPreferredCanvasFormat();
        context.configure({"device":this.device, "format":navigator.gpu.getPreferredCanvasFormat()});
        const canvasTexture = context.getCurrentTexture();
        this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
      } else {
        const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment: ${texture?.descriptor?.format ?? "<unknown format>"}` });
        new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(depthStencilAttachment.view.descriptor, undefined, 4) });
        const texDesc = this._processCommandArgs(texture.descriptor);
        if (texDesc.usage) {
          texDesc.usage = this._getFlagString(texDesc.usage, GPUTextureUsage);
        }
        new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(texDesc, undefined, 4) });
      }
    }
  }

  _showCaptureCommandInfo_setBindGroup(args, commandInfo, index, collapsed) {
    const id = args[1].__id;
    const bindGroup = this.database.getObject(id);
    if (bindGroup) {
      const bindGroupGrp = new Collapsable(commandInfo, { collapsed, label: `BindGroup ${index ?? ""} ID:${id}` });
      const bindGroupDesc = bindGroup.descriptor;
      const newDesc = this._processCommandArgs(bindGroupDesc);
      const descStr = JSON.stringify(newDesc, undefined, 4);
      new Widget("pre", bindGroupGrp.body, { text: descStr });

      const self = this;
      function getResourceType(resource) {
        if (resource.__id !== undefined) {
          const obj = self.database.getObject(resource.__id);
          if (obj) {
            return obj.constructor.name;
          }
        }
        if (resource.buffer) {
          return "Buffer";
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

      for (const entry of bindGroupDesc.entries) {
        const binding = entry.binding;
        const resource = entry.resource;
        const groupLabel = index !== undefined ? `Group ${index} ` : "";
        const resourceGrp = new Collapsable(commandInfo, { collapsed, label: `${groupLabel}Binding ${binding}: ${getResourceType(resource)} ID:${getResourceId(resource)}` });
        if (resource.__id !== undefined) {
          const obj = this.database.getObject(resource.__id);
          if (obj) {
            if (obj instanceof Sampler) {
              new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
              new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
            } else if (obj instanceof TextureView) {
              const texture = obj.parent;
              if (texture && texture.gpuTexture) {
                const viewWidth = 256;
                const viewHeight = Math.round(viewWidth * (texture.height / texture.width));
                const canvas = new Widget("canvas", resourceGrp.body, { style: "margin-left: 20px; margin-top: 10px;" });
                canvas.element.width = viewWidth;
                canvas.element.height = viewHeight;
                const context = canvas.element.getContext('webgpu');
                const dstFormat = navigator.gpu.getPreferredCanvasFormat();
                context.configure({"device":this.device, "format":navigator.gpu.getPreferredCanvasFormat()});
                const canvasTexture = context.getCurrentTexture();
                this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
              } else {
                new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
                new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
                if (texture) {
                  new Div(resourceGrp.body, { text: `GPUTexture ID:${texture.id}` });
                  const newDesc = this._processCommandArgs(texture.descriptor);
                  if (newDesc.usage) {
                    newDesc.usage = this._getFlagString(newDesc.usage, GPUTextureUsage);
                  }
                  new Widget("pre", resourceGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
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
            const buffer = this.database.getObject(bufferId);
            if (buffer) {
              const bufferDesc = buffer.descriptor;
              const newDesc = this._processCommandArgs(bufferDesc);
              if (newDesc.usage) {
                newDesc.usage = this._getFlagString(newDesc.usage, GPUBufferUsage);
              }
              new Widget("pre", resourceGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
            } else {
              new Div(resourceGrp.body, { text: `Buffer ID:${bufferId}` });
            }
          } else {
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(resource, undefined, 4) });
          }
        }
      }
    }
  }

  _showCaptureCommandInfo_setPipeline(args, commandInfo, collapsed) {
    const id = args[0].__id;
    const pipeline = this.database.getObject(id);
    if (pipeline) {
      const pipelineGrp = new Collapsable(commandInfo, { collapsed, label: `Pipeline ID:${id}` });
      const desc = pipeline.descriptor;
      const newDesc = this._processCommandArgs(desc);
      const descStr = JSON.stringify(newDesc, undefined, 4);
      new Widget("pre", pipelineGrp.body, { text: descStr });

      const vertexId = desc.vertex?.module?.__id;
      const fragmentId = desc.fragment?.module?.__id;

      if (vertexId !== undefined && vertexId === fragmentId) {
        const module = this.database.getObject(vertexId);
        if (module) {
          const vertexEntry = desc.vertex?.entryPoint;
          const fragmentEntry = desc.fragment?.entryPoint;
          const grp = new Collapsable(commandInfo, { collapsed, label: `Module ID:${vertexId} Vertex: ${vertexEntry} Fragment: ${fragmentEntry}` });
          const code = module.descriptor.code;
          new Widget("pre", grp.body, { text: code });
        }
      } else {
        if (vertexId !== undefined) {
          const vertexModule = this.database.getObject(vertexId);
          if (vertexModule) {
            const vertexEntry = desc.vertex?.entryPoint;

            const vertexGrp = new Collapsable(commandInfo, { collapsed, label: `Vertex Module ID:${vertexId} Entry: ${vertexEntry}` });
            const code = vertexModule.descriptor.code;
            new Widget("pre", vertexGrp.body, { text: code });
          }
        }
        
        if (fragmentId !== undefined) {
          const fragmentModule = this.database.getObject(fragmentId);
          if (fragmentModule) {
            const fragmentEntry = desc.fragment?.entryPoint;
            const fragmentGrp = new Collapsable(commandInfo, { collapsed, label: `Fragment Module ID:${fragmentId} Entry: ${fragmentEntry}` });
            const code = fragmentModule.descriptor.code;
            new Widget("pre", fragmentGrp.body, { text: code });
          }
        }
      }

      const computeId = desc.compute?.module?.__id;
      if (computeId !== undefined) {
        const computeModule = this.database.getObject(computeId);
        if (computeModule) {
          const computeEntry = desc.compute?.entryPoint;
          const computeGrp = new Collapsable(commandInfo, { collapsed, label: `Compute Module ID:${computeId} Entry: ${computeEntry}` });
          const code = computeModule.descriptor.code;
          new Widget("pre", computeGrp.body, { text: code });
        }
      }
    }
  }

  _showCaptureCommandInfo_writeBuffer(args, commandInfo) {
    const id = args[0].__id;
    const buffer = this.database.getObject(id);
    if (buffer) {
      const bufferGrp = new Collapsable(commandInfo, { label: `Buffer ID:${id}` });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = this._getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
    }
  }

  _showCaptureCommandInfo_setIndexBuffer(args, commandInfo, collapsed) {
    const id = args[0].__id;
    const buffer = this.database.getObject(id);
    if (buffer) {
      const bufferGrp = new Collapsable(commandInfo, { collapsed, label: `Index Buffer ID:${id}` });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = this._getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
    }
  }

  _showCaptureCommandInfo_setVertexBuffer(args, commandInfo, collapsed) {
    const id = args[1]?.__id;
    const buffer = this.database.getObject(id);
    if (buffer) {
      const bufferGrp = new Collapsable(commandInfo, { collapsed, label: `Vertex Buffer ID:${id}` });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = this._getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
    }
  }

  _showCaptureCommandInfo_draw(args, commandInfo, commandIndex, commands) {
    let pipeline = null;
    let vertexBuffer = null;
    let bindGroups = [];
    for (let ci = commandIndex - 1; ci >= 0; --ci) {
      const cmd = commands[ci];
      if (cmd.method == "beginRenderPass") {
        break;
      }
      if (cmd.method == "setVertexBuffer" && !vertexBuffer) {
        vertexBuffer = cmd;
      }
      if (cmd.method == "setPipeline" && !pipeline) {
        pipeline = cmd;
      }
      if (cmd.method == "setBindGroup") {
        const bindGroupIndex = cmd.args[0];
        if (!bindGroups[bindGroupIndex]) {
          bindGroups[bindGroupIndex] = cmd;
        }
      }
    }

    if (pipeline) {
      this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
    }
    if (vertexBuffer) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer.args, commandInfo, true);
    }
    for (const index in bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
    }
  }

  _showCaptureCommandInfo_drawIndexed(args, commandInfo, commandIndex, commands) {
    let pipeline = null;
    let vertexBuffer = null;
    let indexBuffer = null;
    let bindGroups = [];
    for (let ci = commandIndex - 1; ci >= 0; --ci) {
      const cmd = commands[ci];
      if (cmd.method == "beginRenderPass") {
        break;
      }
      if (cmd.method == "setIndexBuffer" && !indexBuffer) {
        indexBuffer = cmd;
      }
      if (cmd.method == "setVertexBuffer" && !vertexBuffer) {
        vertexBuffer = cmd;
      }
      if (cmd.method == "setPipeline" && !pipeline) {
        pipeline = cmd;
      }
      if (cmd.method == "setBindGroup") {
        const bindGroupIndex = cmd.args[0];
        if (!bindGroups[bindGroupIndex]) {
          bindGroups[bindGroupIndex] = cmd;
        }
      }
    }

    if (pipeline) {
      this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
    }
    if (indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(indexBuffer.args, commandInfo, true);
    }
    if (vertexBuffer) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer.args, commandInfo, true);
    }
    for (const index in bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
    }
  }

  _showCaptureCommandInfo_drawIndirect(args, commandInfo, commandIndex, commands) {
    let pipeline = null;
    let vertexBuffer = null;
    let bindGroups = [];
    for (let ci = commandIndex - 1; ci >= 0; --ci) {
      const cmd = commands[ci];
      if (cmd.method == "beginRenderPass") {
        break;
      }
      if (cmd.method == "setVertexBuffer" && !vertexBuffer) {
        vertexBuffer = cmd;
      }
      if (cmd.method == "setPipeline" && !pipeline) {
        pipeline = cmd;
      }
      if (cmd.method == "setBindGroup") {
        const bindGroupIndex = cmd.args[0];
        if (!bindGroups[bindGroupIndex]) {
          bindGroups[bindGroupIndex] = cmd;
        }
      }
    }

    if (pipeline) {
      this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
    }
    if (vertexBuffer) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer.args, commandInfo, true);
    }
    for (const index in bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
    }
  }

  _showCaptureCommandInfo_drawIndexedIndirect(args, commandInfo, commandIndex, commands) {
    let pipeline = null;
    let vertexBuffer = null;
    let indexBuffer = null;
    let bindGroups = [];
    for (let ci = commandIndex - 1; ci >= 0; --ci) {
      const cmd = commands[ci];
      if (cmd.method == "beginRenderPass") {
        break;
      }
      if (cmd.method == "setIndexBuffer" && !indexBuffer) {
        indexBuffer = cmd;
      }
      if (cmd.method == "setVertexBuffer" && !vertexBuffer) {
        vertexBuffer = cmd;
      }
      if (cmd.method == "setPipeline" && !pipeline) {
        pipeline = cmd;
      }
      if (cmd.method == "setBindGroup") {
        const bindGroupIndex = cmd.args[0];
        if (!bindGroups[bindGroupIndex]) {
          bindGroups[bindGroupIndex] = cmd;
        }
      }
    }

    if (pipeline) {
      this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
    }
    if (indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(indexBuffer.args, commandInfo, true);
    }
    if (vertexBuffer) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer.args, commandInfo, true);
    }
    for (const index in bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
    }
  }

  _showCaptureCommandInfo(name, method, args, commandInfo, commandIndex, commands) {
    commandInfo.html = "";

    new Div(commandInfo, { text: `${name} ${method}`, style: "background-color: #575; padding-left: 20px; line-height: 40px;" });

    if (method == "beginRenderPass") {
      const desc = args[0];
      const colorAttachments = desc.colorAttachments;
      for (const i in colorAttachments) {
        const attachment = colorAttachments[i];
        const textureView = this.database.getObject(attachment.view.__id);
        if (textureView) {
          const texture = textureView.parent;
          if (texture) {
            const format = texture.descriptor.format;
            new Div(commandInfo, { text: `Color ${i}: ${format}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
          }
        }
      }
      const depthStencilAttachment = desc.depthStencilAttachment;
      if (depthStencilAttachment) {
        const textureView = this.database.getObject(depthStencilAttachment.view.__id);
        if (textureView) {
          const texture = textureView.parent;
          if (texture) {
            const format = texture.descriptor.format;
            new Div(commandInfo, { text: `Depth-Stencil: ${format}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
          }
        }
      }
    }

    const argsGroup = new Collapsable(commandInfo, { label: "Arguments" });
    const newArgs = this._processCommandArgs(args);
    if (InspectorWindow._commandArgs[method]) {
      const args = InspectorWindow._commandArgs[method];
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
      this._showCaptureCommandInfo_beginRenderPass(args, commandInfo);
    } else if (method == "setBindGroup") {
      this._showCaptureCommandInfo_setBindGroup(args, commandInfo);
    } else if (method == "setPipeline") {
      this._showCaptureCommandInfo_setPipeline(args, commandInfo);
    } else if (method == "writeBuffer") {
      this._showCaptureCommandInfo_writeBuffer(args, commandInfo);
    } else if (method == "setIndexBuffer") {
      this._showCaptureCommandInfo_setIndexBuffer(args, commandInfo);
    } else if (method == "setVertexBuffer") {
      this._showCaptureCommandInfo_setVertexBuffer(args, commandInfo);
    } else if (method == "drawIndexed") {
      this._showCaptureCommandInfo_drawIndexed(args, commandInfo, commandIndex, commands);
    } else if (method == "draw") {
      this._showCaptureCommandInfo_draw(args, commandInfo, commandIndex, commands);
    } else if (method == "drawIndirect") {
      this._showCaptureCommandInfo_drawIndirect(args, commandInfo, commandIndex, commands);
    } else if (method == "drawIndexedIndirect") {
      this._showCaptureCommandInfo_drawIndexedIndirect(args, commandInfo, commandIndex, commands);
    }
  }



  _addRecordingData(data, index, count) {
    try {
      index = parseInt(index);
      count = parseInt(count);
    } catch (e) {
      return;
    }

    if (this._recordingData.length == 0) {
      this._recordingData.length = count;
    }

    if (this._recordingData.length != count) {
      console.log("Invalid Recording Chunk count", count, this._recordingData.length);
      return;
    }

    if (index >= count) {
      console.log("Invalid Recording Chunk index", index, count);
      return;
    }

    this._recordingData[index] = data;

    let pending = false;
    let missingIndex = null;
    for (let i = 0; i < count; ++i) {
      if (this._recordingData[i] === undefined) {
        pending = true;
        missingIndex = i;
        break;
      }
    }
    if (pending) {
      return;
    }

    this.recorderDataPanel.html = "";

    // TODO: How to display the recording file?

    const html = this._recordingData.join();
    new Widget("pre", this.recorderDataPanel, { text: html });

    //const nonceData = new Uint8Array(16);
    //const nonce = encodeBase64(crypto.getRandomValues(nonceData));
    //const html = this._recordingData.join().replace("<script>", `<script nonce="${nonce}">`).replace("script-src *", `script-src * 'nonce-${nonce}' strict-dynamic`);

    /*const f = document.createElement("iframe");
    f.sandbox = "allow-scripts";
    //const url = 'data:text/html;charset=utf-8,' + encodeURI(html);
    const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
    f.src = url;

    new Widget(f, this.recorderDataPanel, { style: "width: calc(100% - 10px);" });*/

    //f.contentWindow.document.open();
    //f.contentWindow.document.write(html);
    //f.contentWindow.document.close();
  }

  _objectLabelChanged(id, object, label) {
    if (object && object.widget) {
      object.nameWidget.text = label || object.constructor.name;
    }
  }

  _resetInspectorPanel() {
    this._selectedObject = null;
    this._selectedGroup = null;
    this.inspectorGUI.html = "";

    const pane1 = new Span(this.inspectorGUI);

    const objectsTab = new TabWidget(pane1);
    const objectsPanel = new Div(null, { style: "font-size: 11pt; overflow: auto; height: calc(-115px + 100vh);" });
    objectsTab.addTab("Objects", objectsPanel);

    const pane3 = new Span(this.inspectorGUI, { style: "padding-left: 20px; flex-grow: 1; overflow: hidden;" });

    const inspectTab = new TabWidget(pane3);
    this.inspectPanel = new Div(null, { class: "inspector_panel_content" });
    inspectTab.addTab("Inspect", this.inspectPanel);

    this.uiAdapters = this._createObjectListUI(objectsPanel, "Adapters");
    this.uiDevices = this._createObjectListUI(objectsPanel, "Devices");
    this.uiRenderPipelines = this._createObjectListUI(objectsPanel, "Render Pipelines");
    this.uiComputePipelines = this._createObjectListUI(objectsPanel, "Compute Pipelines");
    this.uiShaderModules = this._createObjectListUI(objectsPanel, "Shader Modules");
    this.uiBuffers = this._createObjectListUI(objectsPanel, "Buffers");
    this.uiTextures = this._createObjectListUI(objectsPanel, "Textures");
    this.uiTextureViews = this._createObjectListUI(objectsPanel, "Texture Views");
    this.uiSamplers = this._createObjectListUI(objectsPanel, "Samplers");
    this.uiBindGroups = this._createObjectListUI(objectsPanel, "BindGroups");
    this.uiBindGroupLayouts = this._createObjectListUI(objectsPanel, "BindGroupLayouts");
    this.uiPipelineLayouts = this._createObjectListUI(objectsPanel, "PipelineLayouts");
    this.uiPendingAsyncRenderPipelines = this._createObjectListUI(objectsPanel, "Pending Async Render Pipelines");
    this.uiPendingAsyncComputePipelines = this._createObjectListUI(objectsPanel, "Pending Async Compute Pipelines");
  }

  _updateFrameStats() {
    this.uiFrameTime.text = `Frame Time: ${this.database.frameTime.toFixed(2)}ms`;
    const renderPassCount = this.database.renderPassCount.toLocaleString("en-US");
    this.uiFrameRenderPasses.text = `Frame Render Passes: ${renderPassCount}`;
    const totalTextureMemory = this.database.totalTextureMemory.toLocaleString("en-US");
    this.uiTotalTextureMemory.text = `Texture Memory: ${totalTextureMemory} Bytes`;
    const totalBufferMemory = this.database.totalBufferMemory.toLocaleString("en-US");
    this.uiTotalBufferMemory.text = `Buffer Memory: ${totalBufferMemory} Bytes`;
  }

  _deleteObject(id, object) {
    object?.widget?.remove();
    this._updateObjectStat(object);
  }

  _updateObjectStat(object) {
    if (object instanceof Adapter) {
      this.uiAdapters.count.text = `${this.database.adapters.size}`;
    } else if (object instanceof Device) {
      this.uiDevices.count.text = `${this.database.devices.size}`;
    } else if (object instanceof Buffer) {
      this.uiBuffers.count.text = `${this.database.buffers.size}`;
    } else if (object instanceof Sampler) {
      this.uiSamplers.count.text = `${this.database.samplers.size}`;
    } else if (object instanceof Texture) {
      this.uiTextures.count.text = `${this.database.textures.size}`;
    } else if (object instanceof ShaderModule) {
      this.uiShaderModules.count.text = `${this.database.shaderModules.size}`;
    } else if (object instanceof BindGroupLayout) {
      this.uiBindGroupLayouts.count.text = `${this.database.bindGroupLayouts.size}`;
    } else if (object instanceof PipelineLayout) {
      this.uiPipelineLayouts.count.text = `${this.database.pipelineLayouts.size}`;
    } else if (object instanceof BindGroup) {
      this.uiBindGroups.count.text = `${this.database.bindGroups.size}`;
    } else if (object instanceof RenderPipeline) {
      this.uiPendingAsyncRenderPipelines.count.text = `${this.database.pendingRenderPipelines.size}`;
      this.uiRenderPipelines.count.text = `${this.database.renderPipelines.size}`;
    } else if (object instanceof ComputePipeline) {
      this.uiPendingAsyncComputePipelines.count.text = `${this.database.pendingComputePipelines.size}`;
      this.uiComputePipelines.count.text = `${this.database.computePipelines.size}`;
    }
  }

  _addObject(object, pending) {
    this._updateObjectStat(object);
    if (object instanceof Adapter) {
      this._addObjectToUI(object, this.uiAdapters);
      this.uiAdapters.count.text = `${this.database.adapters.size}`;
    } else if (object instanceof Device) {
      this._addObjectToUI(object, this.uiDevices);
      this.uiDevices.count.text = `${this.database.devices.size}`;
    } else if (object instanceof Buffer) {
      this._addObjectToUI(object, this.uiBuffers);
      this.uiBuffers.count.text = `${this.database.buffers.size}`;
    } else if (object instanceof Sampler) {
      this._addObjectToUI(object, this.uiSamplers);
      this.uiSamplers.count.text = `${this.database.samplers.size}`;
    } else if (object instanceof Texture) {
      this._addObjectToUI(object, this.uiTextures);
      this.uiTextures.count.text = `${this.database.textures.size}`;
    } else if (object instanceof TextureView) {
        this._addObjectToUI(object, this.uiTextureViews);
        this.uiTextureViews.count.text = `${this.database.textureViews.size}`;
    } else if (object instanceof ShaderModule) {
      this._addObjectToUI(object, this.uiShaderModules);
      this.uiShaderModules.count.text = `${this.database.shaderModules.size}`;
    } else if (object instanceof BindGroupLayout) {
      this._addObjectToUI(object, this.uiBindGroupLayouts);
      this.uiBindGroupLayouts.count.text = `${this.database.bindGroupLayouts.size}`;
    } else if (object instanceof PipelineLayout) {
      this._addObjectToUI(object, this.uiPipelineLayouts);
      this.uiPipelineLayouts.count.text = `${this.database.pipelineLayouts.size}`;
    } else if (object instanceof BindGroup) {
      this._addObjectToUI(object, this.uiBindGroups);
      this.uiBindGroups.count.text = `${this.database.bindGroups.size}`;
    } else if (object instanceof RenderPipeline) {
      this._addObjectToUI(object, pending ? this.uiPendingAsyncRenderPipelines : this.uiRenderPipelines);
      if (pending) {
        this.uiPendingAsyncRenderPipelines.count.text = `${this.database.pendingRenderPipelines.size}`;
      } else {
        this.uiRenderPipelines.count.text = `${this.database.renderPipelines.size}`;
      }
    } else if (object instanceof ComputePipeline) {
      this._addObjectToUI(object, pending ? this.uiPendingAsyncComputePipelines : this.uiComputePipelines);
      if (pending) {
        this.uiPendingAsyncComputePipelines.count.text = `${this.database.pendingComputePipelines.size}`;
      } else {
        this.uiComputePipelines.count.text = `${this.database.computePipelines.size}`;
      }
    }
  }

  _getDescriptorArray(object, array) {
    const newArray = [];
    for (const item of array) {
      if (item instanceof Array) {
        newArray.push(this._getDescriptorArray(object, item));
      } else if (item instanceof Object) {
        newArray.push(this._getDescriptorInfo(object, item));
      } else {
        newArray.push(item);
      }
    }
    return newArray;
  }

  _getFlagString(value, flags) {
    function _addFlagString(flags, flag) {
      return flags === "" ? flag : `${flags} | ${flag}`;
    }
    let flagStr = "";
    for (const flagName in flags) {
      const flag = flags[flagName];
      if (value & flag) {
        flagStr = _addFlagString(flagStr, flagName);
      }
    }
    return flagStr;
  }

  _getDescriptorInfo(object, descriptor) {
    const info = {};
    if (descriptor === null) {
      return null;
    }
    if (descriptor["__id"] !== undefined) {
      const obj = this.database.getObject(descriptor["__id"]);
      if (obj) {
        return `${obj.constructor.name} ${descriptor["__id"]}`;
      }
      return `Object ${descriptor["__id"]}`;
    }

    for (const key in descriptor) {
      const value = descriptor[key];
      if (object instanceof Buffer && key == "usage") {
        const usage = this._getFlagString(value, GPUBufferUsage);
        info[key] = usage || "NONE";
      } else if (object instanceof Texture && key == "usage") {
        let usage = this._getFlagString(value, GPUTextureUsage);
        info[key] = usage || "NONE";
      } else if (value instanceof Array) {
        info[key] = this._getDescriptorArray(object, value);
      } else if (value instanceof Object) {
        if (value["__id"] !== undefined) {
          const obj = this.database.getObject(value["__id"]);
          if (obj) {
            info[key] = `${obj.constructor.name} ${value["__id"]}`;
          } else {
            info[key] = `Object ${value["__id"]}`;
          }
        } else {
          info[key] = this._getDescriptorInfo(object, value);
        }
      } else {
        info[key] = value;
      }
    }
    return info;
  }

  _createTexturePreview(texture, parent, width, height) {
    width ??= texture.width;
    height ??= texture.height;
    const canvas = new Widget("canvas", parent);
    canvas.element.width = width;
    canvas.element.height = height;
    const context = canvas.element.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const device = this.device;
    context.configure({ device, format });
    const canvasTexture = context.getCurrentTexture();
    const formatInfo = TextureFormatInfo[texture.descriptor.format];
    let srcView;
    if (formatInfo.isDepthStencil) {
      if (formatInfo.hasDepth) {
        srcView = texture.gpuTexture.createView({ aspect: "depth-only" });
      } else {
        srcView = texture.gpuTexture.createView({ aspect: "depth-only" })
      }
      srcView = formatInfo.isDepthStencil
        ? texture.gpuTexture.createView({ aspect: "depth-only" })
        : texture.gpuTexture.createView();
    } else {
      srcView = texture.gpuTexture.createView();
    }
    this.textureUtils.blitTexture(srcView, texture.descriptor.format, canvasTexture.createView(), format);
  }

  _inspectObject(object) {
    this.inspectPanel.html = "";

    this._inspectedObject = object;

    const infoBox = new Div(this.inspectPanel, { style: "background-color: #353; padding: 10px;" });
    const idName = object.id < 0 ? "CANVAS" : object.id;
    new Div(infoBox, { text: `${object.name} ID: ${idName}` });

    if (object instanceof Texture) {
      const gpuSize = object.getGpuSize();
      const sizeStr = gpuSize < 0 ? "<unknown>" : gpuSize.toLocaleString("en-US");
      new Div(infoBox, { text: `GPU Size: ${sizeStr} Bytes`, style: "font-size: 10pt; margin-top: 5px;" });
    }

    const dependencies = this.database.getObjectDependencies(object);
    new Div(infoBox, { text: `Used By: ${dependencies.length} Objects`, style: "font-size: 10pt; color: #aaa;"});
    const depGrp = new Div(infoBox, { style: "font-size: 10pt; color: #aaa; padding-left: 20px; max-height: 50px; overflow: auto;" })
    for (const dep of dependencies) {
      new Div(depGrp, { text: `${dep.name} ${dep.id}` });
    }

    const descriptionBox = new Div(this.inspectPanel, { style: "height: calc(-200px + 100vh); overflow: auto;" });

    if (object instanceof ShaderModule) {
      const text = object.descriptor.code;
      new Widget("pre", descriptionBox, { text });
    } else {
      const desc = this._getDescriptorInfo(object, object.descriptor);
      const text = JSON.stringify(desc, undefined, 4);
      new Widget("pre", descriptionBox, { text });
    }

    if (object instanceof Texture) {
      const self = this;
      const loadButton = new Button(descriptionBox, { label: "Load", callback: () => {
        self.port.postMessage({ action: "inspect_request_texture", id: object.id });
      }});
      if (TextureFormatInfo[object.descriptor.format]?.isDepthStencil) {
        loadButton.disabled = true;
        loadButton.tooltip = "Previewing depth-stencil textures is currently disabled.";
      }
      if (object.gpuTexture) {
        this._createTexturePreview(object, descriptionBox);
      }
    }
  }

  _createObjectListUI(parent, name) {
    const div = new Div(parent);

    const titleBar = new Div(div, { class: "title_bar" });
    
    const collapse = new Span(titleBar, { class: "object_list_collapse", text: "+", style: "margin-right: 10px;" })

    new Span(titleBar, { class: "object_type", text: name });
    const objectCount = new Span(titleBar, { class: "object_type", text: "0", style: "margin-left: 10px;" });

    const objectList = new Widget("ol", div, { class: ["object_list", "collapsed"] });
    objectList.collapse = collapse;
    objectList.count = objectCount;

    const self = this;

    titleBar.element.onclick = function() {
      if (self._selectedGroup && self._selectedGroup != objectList) {
        self._selectedGroup.collapse.text = "+";
        self._selectedGroup.element.className = "object_list collapsed";
        self._selectedGroup = null;
      }
      if (collapse.text == "-") {
        collapse.text = "+";
        objectList.element.className = "object_list collapsed";
      } else {
        collapse.text = "-";
        objectList.element.className = "object_list";
        self._selectedGroup = objectList;
      }
    };

    return objectList;
  }

  _addObjectToUI(object, ui) {
    const name = `${object.name}`;
    let type = "";
    if (object instanceof ShaderModule) {
      if (object.hasVertexEntries) {
        type += " VERTEX";
      }
      if (object.hasFragmentEntries) {
        type += " FRAGMENT";
      }
      if (object.hasComputeEntries) {
        type += " COMPUTE";
      }
    } else if (object instanceof Texture) {
      const depth = object.depthOrArrayLayers > 1 ? `x${object.depthOrArrayLayers}` : "";
      type += ` ${object.width}x${object.height}${depth} ${object.descriptor.format}`;
    }

    object.widget = new Widget("li", ui);

    object.nameWidget = new Span(object.widget, { text: name });
    const idName = object.id < 0 ? "CANVAS" : object.id;
    new Span(object.widget, { text: `ID: ${idName}`, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
    if (type) {
      new Span(object.widget, { text: type, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
    }

    const self = this;
    object.widget.element.onclick = () => {
      if (self._selectedObject) {
        self._selectedObject.widget.element.classList.remove("selected");
      }
      object.widget.element.classList.add("selected");
      self._selectedObject = object;
      self._inspectObject(object);
    };
  }
}

InspectorWindow._commandArgs = {
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
  "dispatchWorkgroup": ["workgroupCountX", "workgroupCountY", "workgroupCountZ"],
  "dispatchWorkgroupIndirect": ["indirectBuffer", "indirectOffset"],
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
