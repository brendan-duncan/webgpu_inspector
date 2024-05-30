import { CaptureStatistics } from "./capture_statistics.js";
import {
  Sampler,
  TextureView
} from "./gpu_objects/index.js";
import { Button } from "./widget/button.js";
import { Collapsable } from "./widget/collapsable.js";
import { Dialog } from "./widget/dialog.js";
import { Div } from "./widget/div.js";
import { NumberInput } from "./widget/number_input.js";
import { Span } from "./widget/span.js";
import { TextArea } from "./widget/text_area.js";
import { TextInput } from "./widget/text_input.js";
import { Widget } from "./widget/widget.js";
import { getFlagString } from "../utils/flags.js";
import { Select } from "./widget/select.js";
import { Actions, PanelActions } from "../utils/actions.js";
import { getFormatFromReflection } from "../utils/reflection_format.js";
import { ResourceType, WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";
import { CaptureData } from "./capture_data.js";

export class CapturePanel {
  constructor(window, parent) {
    this.window = window;

    const self = this;
    const port = window.port;

    this.statistics = new CaptureStatistics();

    this._captureData = null;

    const controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    new Button(controlBar, { label: "Capture", style: "background-color: #557;", callback: () => { 
      try {
        this._captureData = new CaptureData(this.database);
        this._captureData.onCaptureFrameResults.addListener(self._captureFrameResults, self);
        this._captureData.onUpdateCaptureStatus.addListener(self._updateCaptureStatus, self);

        const frame = self.captureMode === 0 ? -1 : self.captureSpecificFrame;
        self.port.postMessage({ action: PanelActions.Capture, maxBufferSize: self.maxBufferSize, frame });
      } catch (e) {
        console.error(e.message);
      }
    } });

    this.captureMode = 0;

    new Select(controlBar, {
      options: ["Immediate", "Specific Frame"],
      style: "margin-right: 10px; vertical-align: middle;",
      onChange: (_, index) => {
        self.captureMode = index;
        if (self.captureMode === 0) {
          self.captureFrameEdit.style.display = "none";
        } else {
          self.captureFrameEdit.style.display = "inline-block";
        }
      }
    });

    this.captureSpecificFrame = 0;
    this.captureFrameEdit = new NumberInput(controlBar, {
      value: this.captureSpecificFrame,
      min: -1,
      step: 1,
      precision: 0,
      style: "display: inline-block; width: 75px; margin-right: 10px; vertical-align: middle;",
      onChange: (value) => {
        self.captureSpecificFrame = Math.max(value, -1);
      }
    });
    if (this.captureMode === 0) {
      this.captureFrameEdit.style.display = "none";
    }

    this.maxBufferSize = (1024 * 1024) / 2;
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

    this._frameImageList = [];
    this._lastSelectedCommand = null;
    this._gpuTextureMap = new Map();
    this._passEncoderCommands = new Map();

    port.addListener((message) => {
      if (!self._captureData) {
        return;
      }
      switch (message.action) {
        case Actions.CaptureTextureFrames: {
          self._captureData.captureTextureFrames(message);
          self._updateCaptureStatus();
          break;
        }
        case Actions.CaptureFrameResults: {
          self._captureData.captureFrameResults(message);
          break;
        }
        case Actions.CaptureFrameCommands: {
          self._captureData.captureFrameCommands(message);
          break;
        }
        case Actions.CaptureBuffers: {
          self._captureData.captureBuffers(message);
          self._updateCaptureStatus();
          break;
        }
        case Actions.CaptureBufferData: {
          self._captureData.captureBufferData(message);
          break;
        }
      }
    });
  }

  _clampedTextureWidth(texture) {
    return Math.max(Math.min(Math.max(texture.width, texture.height), 256), 64);
  }

  _getObject(id) {
    return this.database.getObject(id);
  }

  _updateCaptureStatus() {
    let text = this._captureData?.getCaptureStatus() ?? "";
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

  _filterCommands(filter, commands) {
    for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
      const command = commands[commandIndex];
      if (!command) {
        break;
      }
      const method = command.method;
      const widget = command.widget;
      if (widget) {
        if (method.includes(filter)) {
          widget.element.style.display = "block";
        } else {
          widget.element.style.display = "none";
        }
      }
    }
  }

  _captureFrameResults(frame, commands) {
    const contents = this._capturePanel;

    this._captureFrame.text = `Frame ${frame}`;
    this._captureStats.style.display = "inline-block";

    contents.html = "";

    this._captureCommands = commands;

    this.database.capturedObjects.clear();
    this._frameImageList.length = 0;
    this._passEncoderCommands.clear();

    this._gpuTextureMap.forEach((value) => {
      value.removeReference();
    });
    this._gpuTextureMap.clear();

    this._frameImages = new Span(contents, { class: "capture_frameImages" });
    const _frameContents = new Span(contents, { class: "capture_frameContents" });
    const commandInfo = new Span(contents, { class: "capture_commandInfo" });

    const self = this;

    const filterArea = new Div(_frameContents, { class: "capture_filterArea" });
    new Span(filterArea, { text: "Filter: ", style: "margin-right: 5px;" });
    this.filterEdit = new TextInput(filterArea, { style: "width: 200px;", placeholder: "Filter", onEdit: (value) => {
      self._filterCommands(value, commands);
    } });

    const frameContents = new Div(_frameContents, { class: "capture_frame" });

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

    let nestedDebugGroup = 0;

    // Pass index is based on end, not begin, so we need to prepare the pass index map first.
    let renderPassIndex = 0;
    let computePassIndex = 0;
    let renderBundleIndex = 0;
    for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
      const command = commands[commandIndex];
      command.id = commandIndex;
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
      } else if (method === "createRenderBundleEncoder") {
        passEncoderMap.set(command.result, -3);
      } else if (method === "finish") {
        const type = passEncoderMap.get(command.object);
        if (type === -3) {
          passEncoderMap.set(command.object, renderBundleIndex++);
        }
      }
    }

    let first = true;
    for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
      const command = commands[commandIndex];
      if (!command) {
        break;
      }
      //const className = command.class;
      const method = command.method;
      const args = command.args;
      //const name = `${className ?? "__"}`;

      stats.updateStats(this.database, command);

      // skip empty debug groups
      if (method === "pushDebugGroup") {
        let index = commandIndex + 1;
        let nextCommand = commands[index];
        let found = false;
        let nestedGroup = 1;
        while (nextCommand) {
          const nextMethod = nextCommand.method;
          if (nextMethod === "pushDebugGroup") {
            nestedGroup++;
          } else if (nextMethod === "popDebugGroup") {
            nestedGroup--;
            if (nestedGroup === 0) {
              break;
            }
          } else {
            found = true;
            break;
          }
          index++;
          nextCommand = commands[index];
        }

        if (!found) {
          commandIndex = index;
          continue;
        }
      }

      let debugGroup = debugGroupStack[debugGroupStack.length - 1];

      if (method === "beginRenderPass") {
        const passIndex = passEncoderMap.get(command.result);

        this._passEncoderCommands.set(command.result, [command]);

        command._passIndex = passIndex;
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_renderpass" });

        const header = new Div(currentBlock, { id: `RenderPass_${passIndex}`, class: "capture_renderpass_header" });
        const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
        let headerText = `Render Pass ${passIndex}`;
        if (command.duration !== undefined) {
          headerText += ` Duration:${command.duration}ms`;
        }
        command.header = new Span(header, { text: headerText });
        const extra = new Span(header, { style: "margin-left: 10px;" });
        const block = new Div(currentBlock, { class: "capture_renderpass_block" });
        header.element.onclick = () => {
          block.element.classList.toggle("collapsed");
          if (block.element.classList.contains("collapsed")) {
            headerIcon.text = "+";
            extra.text = "...";
          } else {
            headerIcon.text = "-";
            extra.text = "";
          }
        };
        currentBlock = block;
        currentBlock._passIndex = passIndex;

        for (const attachment of args[0].colorAttachments) {
          const textureView = this._getTextureViewFromAttachment(attachment);
          if (textureView) {
            this.database.capturedObjects.set(textureView.id, textureView);
            const texture = this.database.getTextureFromView(textureView);
            if (texture) {
              this.database.capturedObjects.set(texture.id, texture);
            }
          }
        }

        if (args[0].depthStencilAttachment) {
          const textureView = this._getTextureViewFromAttachment(args[0].depthStencilAttachment);
          if (textureView) {
            this.database.capturedObjects.set(textureView.id, textureView);
            const texture = this.database.getTextureFromView(textureView);
            if (texture) {
              this.database.capturedObjects.set(texture.id, texture);
            }
          }
        }
      } else if (method === "beginComputePass") {
        const passIndex = passEncoderMap.get(command.result);

        this._passEncoderCommands.set(command.result, [command]);
        this._renderBundleCommands = null;

        command._passIndex = passIndex;
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_computepass" });
        const header = new Div(currentBlock, { id: `ComputePass_${passIndex}`, class: "capture_computepass_header" });
        const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
        command.header = new Span(header, { text: `Compute Pass ${passIndex}` });
        const extra = new Span(header, { style: "margin-left: 10px;" });
        const block = new Div(currentBlock);
        header.element.onclick = () => {
          block.element.classList.toggle("collapsed");
          if (block.element.classList.contains("collapsed")) {
            headerIcon.text = "+";
            extra.text = "...";
          } else {
            headerIcon.text = "-";
            extra.text = "";
          }
        };
        currentBlock = block;
        currentBlock._passIndex = passIndex;
      } else if (method === "popDebugGroup") {
        debugGroupStack.pop();
        debugGroup = debugGroupStack[debugGroupStack.length - 1];
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      } else if (method === "createRenderBundleEncoder") {
        const passIndex = command.result.__id ?? passEncoderMap.get(command.result);

        this._passEncoderCommands.set(command.result, [command]);

        command._passIndex = passIndex;
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_renderbundle" });
        const header = new Div(currentBlock, { id: `RenderBundle_${passIndex}`, class: "capture_renderbundle_header" });
        const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
        command.header = new Span(header, { text: `Render Bundle ${passIndex}` });
        const extra = new Span(header, { style: "margin-left: 10px;" });
        const block = new Div(currentBlock);
        header.element.onclick = () => {
          block.element.classList.toggle("collapsed");
          if (block.element.classList.contains("collapsed")) {
            headerIcon.text = "+";
            extra.text = "...";
          } else {
            headerIcon.text = "-";
            extra.text = "";
          }
        };
        currentBlock = block;
        currentBlock._passIndex = passIndex;
        currentBlock._object = command.result;
      } else if (method === "popDebugGroup") {
        debugGroupStack.pop();
        debugGroup = debugGroupStack[debugGroupStack.length - 1];
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      } else if (method !== "pushDebugGroup") {
        const object = command.object;
        const commandArray = this._passEncoderCommands.get(object);
        if (commandArray) {
          commandArray.push(command);
        }

        if (passEncoderMap.has(object)) {
          const passIndex = passEncoderMap.get(object);
          if (currentBlock._passIndex !== passIndex) {
            if (!currentBlock.children.length) {
              currentBlock.remove();
            }
            currentBlock = new Div(debugGroup, { class: "capture_renderpass", style: "margin-top: 5px;" });
            
            const header = new Div(currentBlock, { id: `RenderPass_${passIndex}`, class: "capture_renderpass_header", style: "display: none;" });
            const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
            new Span(header, { text: `Render Pass ${passIndex}` });
            const extra = new Span(header, { style: "margin-left: 10px;" });
            const block = new Div(currentBlock, { class: "capture_renderpass_block" });
            header.element.onclick = () => {
              block.element.classList.toggle("collapsed");
              if (block.element.classList.contains("collapsed")) {
                headerIcon.text = "+";
                extra.text = "...";
              } else {
                headerIcon.text = "-";
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

      const skipCommand = method === "pushDebugGroup" || method === "popDebugGroup";

      if (!skipCommand) {
        const cmd = this._createCommandWidget(currentBlock, commandIndex, command, cmdType, commandInfo);

        if (first) {
          // Start off selecting the first command.
          cmd.element.click();
          first = false;
        }
      }

      if (method === "pushDebugGroup") {
        const colors = [
          ["capture_debugGroup_header1", "capture_debugGroup1"],
          ["capture_debugGroup_header2", "capture_debugGroup2"],
          ["capture_debugGroup_header3", "capture_debugGroup3"],
          ["capture_debugGroup_header4", "capture_debugGroup4"],
          ["capture_debugGroup_header5", "capture_debugGroup5"],
        ];
        const grpIndex = colors[nestedDebugGroup % 5];
        const grpClass = ["capture_debugGroup", grpIndex[1]];
        const hdrClass = ["capture_debugGroup_header", grpIndex[0]];

        const header = new Div(debugGroup, { id: `DebugGroup_${debugGroupIndex}`, class: hdrClass });

        const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;" });
        new Span(header, { text: `${args[0]}` });
        const extra = new Span(header, { style: "margin-left: 10px;" });

        const grp = new Div(debugGroup, { class: grpClass });

        nestedDebugGroup++;

        debugGroupStack.push(grp);
        debugGroupIndex++;
        debugGroup = grp;
        header.element.onclick = () => {
          grp.element.classList.toggle("collapsed");
          if (grp.element.classList.contains("collapsed")) {
            headerIcon.text = "+";
            extra.text = "...";
          } else {
            headerIcon.text = "-";
            extra.text = "";
          }
        };
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      }

      if (method == "popDebugGroup") {
        nestedDebugGroup--;
      }

      if (method === "end") {
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      }

      if (method === "finish" && command.object === currentBlock._object) {
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      }
    }
  }

  _createCommandWidget(currentBlock, commandIndex, command, cmdType, commandInfo) {
    const method = command.method;
    const args = command.args;
    const cmd = new Div(currentBlock, { id: `CaptureCommand_${commandIndex}`, class: cmdType });

    if (method === "end") {
      cmd.element.id = `Pass_${currentBlock._passIndex}_end`;
    } else if (method === "beginRenderPass") {
      cmd.element.id = `RenderPass_${currentBlock._passIndex}_begin`;
    }

    command.widget = cmd;

    let expandButton = null;
    if (method === "executeBundles") {
      cmd.style.paddingLeft = "0px";
      expandButton = new Span(cmd, { class: "expand_button", text: "+" });
      expandButton.element.onclick = () => {
        if (expandButton.panel) {
          expandButton.panel.element.classList.toggle("collapsed");
          if (expandButton.panel.element.classList.contains("collapsed")) {
            expandButton.text = "+";
          } else {
            expandButton.text = "-";
          }
        }
      };
    }

    new Span(cmd, { class: "capture_callnum", text: `${commandIndex}.` });

    const self = this;

    function getName(id, className) {
      if (id === undefined) {
        return "";
      }
      const obj = self._getObject(id);
      if (obj) {
        return `${obj.label || obj.name}(${obj.idName})`;
      }
      return className ?
          `${className}(${id})` :
          `${id}`;
    }
   
    new Span(cmd, { class: "capture_methodName", text: `${method}` });

    if (method === "executeBundles") {
      const bundleNames = [];
      for (const bundle of args[0]) {
        bundleNames.push(getName(bundle.__id, "GPURenderBundle"));
      }
      new Span(cmd, { class: "capture_method_args", text: `bundles:[${bundleNames.join(", ")}]` });

      expandButton.panel = new Div(currentBlock, { class: ["collapsed"] });
      let ci = 0;
      for (const bundle of args[0]) {
        const obj = self._getObject(bundle.__id);
        this.database.capturedObjects.set(bundle.__id, obj);

        const name = getName(bundle.__id, "GPURenderBundle");
        const bundleButton = new Div(expandButton.panel, { class: "capture_renderbundle_header", text: `- ${name}`, style: "margin-left: 20px; margin-bottom: 0px; border-radius: 5px 5px 0px 0px; line-height: 20px;" });
        const bundleGrp = new Div(expandButton.panel, { class: ["render_bundle_group"] });
        bundleButton.element.onclick = () => {
          bundleGrp.element.classList.toggle("collapsed");
          if (bundleGrp.element.classList.contains("collapsed")) {
            bundleButton.text = `+ ${name}`;
          } else {
            bundleButton.text = `- ${name}`;
          }
        };

        if (obj?.commands) {
          for (const bndCommand of obj?.commands) {
            this._createCommandWidget(bundleGrp, ci++, bndCommand, ["capture_command"], commandInfo);
          }
        }
      }

    } else if (method === "createCommandEncoder") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUCommandEncoder")}` });
    } else if (method === "finish") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPUCommandBuffer")}` });
    } if (method === "getMappedRange") {
      new Span(cmd, { class: "capture_method_args", text: getName(command.object) });
    } else if (method === "unmap") {
      new Span(cmd, { class: "capture_method_args", text: getName(command.object) });
    } else if (method === "copyBufferToBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0].__id)} srcOffset:${args[1]} dest:${getName(args[2].__id)} destOffset:${args[3]} size:${args[4]}` });
    } else if (method === "clearBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0].__id)} offset:${args[1]} size:${args[4]}` });
    } else if (method === "copyBufferToTexture") {
      new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0].buffer?.__id)} texture:${getName(args[1].texture?.__id)}` });
    } else if (method === "copyTextureToBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `texture:${getName(args[0].texture?.__id)} buffer:${getName(args[1].buffer?.__id)}` });
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
        this.database.capturedObjects.set(args[1].__id, bg);
        for (const entry of bg.descriptor.entries) {
          if (entry.resource?.__id) {
            const obj = this._getObject(entry.resource.__id);
            this.database.capturedObjects.set(entry.resource.__id, obj);
            if (obj instanceof TextureView) {
              const tex = this._getObject(obj.texture?.id ?? obj.texture);
              if (tex) {
                this.database.capturedObjects.set(tex.id, tex);
              }
            }
          } else if (entry.resource?.buffer?.__id) {
            const obj = this._getObject(entry.resource.buffer.__id);
            this.database.capturedObjects.set(entry.resource.buffer.__id, obj);
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
      this.database.capturedObjects.set(args[0].__id, this._getObject(args[0].__id));
    } else if (method === "setVertexBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `slot:${args[0]} buffer:${getName(args[1].__id)} offset:${args[2] ?? 0}` });
      this.database.capturedObjects.set(args[1].__id, this._getObject(args[1].__id));
    } else if (method === "setIndexBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0].__id)} indexFormat:${args[1]} offset:${args[2] ?? 0}` });
      this.database.capturedObjects.set(args[0].__id, this._getObject(args[0].__id));
    } else if (method === "drawIndexed") {
      new Span(cmd, { class: "capture_method_args", text: `indexCount:${args[0]} instanceCount:${args[1] ?? 1} firstIndex:${args[2] ?? 0} baseVertex:${args[3] ?? 0} firstInstance:${args[4] ?? 0}` });
    } else if (method === "draw") {
      new Span(cmd, { class: "capture_method_args", text: `vertexCount:${args[0]} instanceCount:${args[1] ?? 1} firstVertex:${args[2] ?? 0} firstInstance:${args[3] ?? 0}` });
    } else if (method === "drawIndirect") {
      new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${getName(args[0].__id)} offset:${args[1]}` });
    } else if (method === "drawIndexedIndirect") {
      new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${getName(args[0].__id)} offset:${args[1]}` });
    } else if (method === "dispatchWorkgroups") {
      new Span(cmd, { class: "capture_method_args", text: `countX:${args[0]} countY:${args[1] ?? 1} countZ:${args[2] ?? 1}` });
    } else if (method === "dispatchWorkgroupsIndirect") {
      new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${getName(args[0].__id)} offset:${args[1]}` });
    } else if (method === "pushDebugGroup") {
      debugGroupLabelStack.push(args[0]);
      new Span(cmd, { class: "capture_method_args", text: args[0] });
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
        if (buffers !== "[") {
          buffers += ", ";
        }
        buffers += `${getName(buffer.__id, "GPUCommandBuffer")}`;
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

    return cmd;
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

    const layerRanges = texture.layerRanges;
    
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

      let display = null;
      if (layerRanges) {
        display = {
          exposure: 1.0,
          channels: 0,
          minRange: layerRanges[layer].min,
          maxRange: layerRanges[layer].max
        };
      }

      const context = canvas.element.getContext("webgpu");
      const dstFormat = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ "device": this.window.device, "format": navigator.gpu.getPreferredCanvasFormat() });
      const canvasTexture = context.getCurrentTexture();
      this.textureUtils.blitTexture(layerView, texture.format, 1, canvasTexture.createView(), dstFormat, display);
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

  _showBufferDataType(ui, type, bufferData, offset = 0, radix = 10) {
    if (!type) {
      return;
    }

    radix = type.radix || radix;

    function toString(value, radix) {
      if (radix === 16) {
        return `0x${value.toString(16)}`;
      }
      if (radix === 2) {
        return `0b${value.toString(2)}`;
      }
      if (radix === 8) {
        return `0o${value.toString(8)}`;
      }
      return `${value}`;
    }

    const typeName = this._getTypeName(type);

    if (typeName === "f32") {
      const data = new Float32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${toString(data[0], radix)}`});
    } else if (typeName === "i32") {
      const data = new Int32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${toString(data[0], radix)}`});
    } else if (typeName === "u32") {
      const data = new Uint32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${toString(data[0], radix)}`});
    } else if (typeName === "bool") {
      const data = new Uint32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${data[0] ? "true" : "false"}`});
    } else if (typeName === "vec2i" || typeName === "vec2<i32>") {
      const data = new Int32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${data[1]}`});
    } else if (typeName === "vec2u" || typeName === "vec2<u32>") {
      const data = new Uint32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${data[1]}`});
    } else if (typeName === "vec2f" || typeName === "vec2<f32>") {
      const data = new Float32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${data[1]}`});
    } else if (typeName === "vec3i" || typeName === "vec3<i32>") {
      const data = new Int32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${data[1]}, ${data[2]}`});
    } else if (typeName === "vec3u" || typeName === "vec3<u32>") {
      const data = new Uint32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`});
    } else if (typeName === "vec3f" || typeName === "vec3<f32>") {
      const data = new Float32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`});
    } else if (typeName === "vec4i" || typeName === "vec4<i32>") {
      const data = new Int32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (typeName === "vec4u" || typeName === "vec4<u32>") {
      const data = new Uint32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (typeName === "vec4f" || typeName === "vec4<f32>") {
      const data = new Float32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
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
        this._showBufferDataType(l3, m.type, bufferData, offset + m.offset, radix);
      }
    } else if (type.name === "array") {
      let count = type.count ?? 0;
      if (count === 0) {
        // Runtime length array
        count = (bufferData.length - offset) / (type.stride || type.format.size);
      }

      const arrayUi = new Div(ui, { class: "capture_array_view" });
      let filter = null;
      if (count > 100) {
        filter = new Div(arrayUi, { class: "capture_array_view_filter" });
      }
      const ul = new Widget("ul", arrayUi);
      

      if (count) {
        let subOffset = 0;
        let maxCount = 100;

        const self = this;

        function showArrayData(ul, subOffset, maxCount) {
          let stride = type.stride;
          let elementOffset = offset + (subOffset * stride);
          let subCount = Math.min(count - subOffset, maxCount);
          let format = type.format;
          const formatName = self._getTypeName(format);
          for (let i = 0; i < subCount; ++i) {
            let value = null;
            if (formatName === "f32" || formatName === "atomic<f32>") {
              const data = new Float32Array(bufferData.buffer, elementOffset, 1);
              value = toString(data[0], radix);
            } else if (formatName === "i32" || formatName === "atomic<i32>") {
              const data = new Int32Array(bufferData.buffer, elementOffset, 1);
              value = toString(data[0], radix);
            } else if (formatName === "u32" || formatName === "atomic<u32>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 1);
              value = toString(data[0], radix);
            } else if (formatName === "bool" || formatName === "atomic<bool>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 1);
              value = data[0] ? "true" : "false";
            } else if (formatName === "vec2i" || formatName === "vec2<i32>") {
              const data = new Int32Array(bufferData.buffer, elementOffset, 2);
              value = `${toString(data[0], radix)}, ${data[1]}`;
            } else if (formatName === "vec2u" || formatName === "vec2<u32>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 2);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
            } else if (formatName === "vec2f" || formatName === "vec2<f32>") {
              const data = new Float32Array(bufferData.buffer, elementOffset, 2);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
            } else if (formatName === "vec3i" || formatName === "vec3<i32>") {
              const data = new Int32Array(bufferData.buffer, elementOffset, 3);
              value = `${data[0]}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
            } else if (formatName === "vec3u" || formatName === "vec3<u32>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 3);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
            } else if (formatName === "vec3f" || formatName === "vec3<f32>") {
              const data = new Float32Array(bufferData.buffer, elementOffset, 3);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
            } else if (formatName === "vec4i" || formatName === "vec4<i32>") {
              const data = new Int32Array(bufferData.buffer, elementOffset, 4);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
            } else if (formatName === "vec4u" || formatName === "vec4<u32>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 4);
              value = `${data[0]}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
            } else if (formatName === "vec4f" || formatName === "vec4<f32>") {
              const data = new Float32Array(bufferData.buffer, elementOffset, 4);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
            }

            if (format.isStruct && format.members?.length === 1) {
              const member = format.members[0];
              if (member.isArray) {
                const arrayFormat = member.format;
                const arrayFormatName = self._getTypeName(arrayFormat);
                if (arrayFormatName === "u32" || arrayFormatName === "atomic<u32>") {
                  if (member.count === 1) {
                    const data = new Uint32Array(bufferData.buffer, elementOffset, 1);
                    value = `${toString(data[0], radix)}`;
                  } else if (member.count === 2) {
                    const data = new Uint32Array(bufferData.buffer, elementOffset, 2);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
                  } else if (member.count === 3) {
                    const data = new Uint32Array(bufferData.buffer, elementOffset, 3);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
                  } else if (member.count === 4) {
                    const data = new Uint32Array(bufferData.buffer, elementOffset, 4);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
                  }
                } else if (arrayFormatName === "i32" || arrayFormatName === "atomic<i32>") {
                  if (member.count === 1) {
                    const data = new Int32Array(bufferData.buffer, elementOffset, 1);
                    value = `${toString(data[0], radix)}`;
                  } else if (member.count === 2) {
                    const data = new Int32Array(bufferData.buffer, elementOffset, 2);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
                  } else if (member.count === 3) {
                    const data = new Int32Array(bufferData.buffer, elementOffset, 3);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
                  } else if (member.count === 4) {
                    const data = new Int32Array(bufferData.buffer, elementOffset, 4);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
                  }
                } else if (arrayFormatName === "f32" || arrayFormatName === "atomic<f32>") {
                  if (member.count === 1) {
                    const data = new Float32Array(bufferData.buffer, elementOffset, 1);
                    value = `${toString(data[0], radix)}`;
                  } else if (member.count === 2) {
                    const data = new Float32Array(bufferData.buffer, elementOffset, 2);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
                  } else if (member.count === 3) {
                    const data = new Float32Array(bufferData.buffer, elementOffset, 3);
                    value = `${data[0]}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
                  } else if (member.count === 4) {
                    const data = new Float32Array(bufferData.buffer, elementOffset, 4);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
                  }
                }
              }
            }

            if (value !== null) {
              new Widget("li", ul, { text: `[${i + subOffset}]: ${value}` });
            } else {
              new Widget("li", ul, { text: `[${i + subOffset}]: ${formatName}` });
              const ul2 = new Widget("ul", ul);
              self._showBufferDataType(ul2, format, bufferData, elementOffset);
            }

            elementOffset += stride;
          }
        }

        if (count > 100) {
          new Span(filter, { text: "Offset:" });
          new NumberInput(filter, { value: 0, min: 0, max: count, precision: 0, step: 1, tooltip: "Starting element of the array to display",
            onChange: (value) => {
              try {
                subOffset = Math.max(parseInt(value), 0);
              } catch (e) {
                console.log(e.message);
                subOffset = 0;
              }
              ul.removeAllChildren();
              showArrayData(ul, subOffset, maxCount);
           }, style: "display: inline-block; width: 75px; margin-right: 10px; vertical-align: middle;" });

          new Span(filter, { text: "Count:" });
          new NumberInput(filter, { value: 100, min: 1, max: 1000, precision: 0, step: 1, tooltip: "Number of elements to display",
            onChange: (value) => {
              try {
                maxCount = Math.max(parseInt(value), 1);
              } catch (e) {
                console.log(e.message);
                maxCount = 100;
              }
              ul.removeAllChildren();
              showArrayData(ul, subOffset, maxCount);
            }, style: "display: inline-block; width: 75px; margin-right: 10px; vertical-align: middle;" });
          new Span(filter, { text: `/ ${count}` });
        }

        showArrayData(ul, subOffset, maxCount);
      }
    }
  }

  _setBufferFormat(type, typeName, format, skipStructEncapsulation = false, radix = 10) {
    try {
      let reflect = new WgslReflect(format);
      if (reflect) {
        for (const struct of reflect.structs) {
          if (struct.name === typeName) {
            type.replacement = struct;
            type.replacement.radix = radix;
            //console.log("REPLACEMENT RADIX", type.replacement.radix);
            return;
          }
        }
        // If structs are defined but none of the names match, use the last one.
        if (reflect.structs.length > 0) {
          type.replacement = reflect.structs[reflect.structs.length - 1];
          type.replacement.radix = radix;
          //console.log("REPLACEMENT RADIX", type.replacement.radix);
          return;
        
        }
      }
      if (!skipStructEncapsulation) {
        // basic and array types need to be wrapped in a struct for the reflection to work.
        const newTypeName = `_${type.name}`;
        const structFormat = `struct _${type.name} { _: ${format} }`;
        this._setBufferFormat(type, newTypeName, structFormat, true, radix);
      }
    } catch (e) {
    }
  }

  _createFormatButton(parentWidget, resource, bufferDataUI, bufferData) {
    function resourceType(resource) {
      return resource.type.replacement || resource.type;
    }

    const self = this;

    new Button(parentWidget, { label: "Format", callback: () => {
      const dialog = new Dialog({
        title: 'Buffer Format',
        width: 300,
        draggable: true,
      });

      const format = getFormatFromReflection(resourceType(resource));
  
      const nameEdit = new TextArea(dialog.body, {
        value: format,
        style: 'width: 100%; height: 200px;',
      });

      const optionssRow = new Div(dialog.body, { style: "padding-left: 10px; margin-top: 4px;" });
      new Span(optionssRow, { text: "Radix:", style: "margin-right: 5px;" });
      const radixSelect = [ 10, 16, 8, 2 ];
      let radix = resourceType(resource)?.radix || 10;
      new Select(optionssRow, {
        options: [ "Decimal", "Hexadecimal", "Octal", "Binary" ],
        value: radix === 16 ? "Hexadecimal" : radix === 8 ? "Octal" : radix === 2 ? "Binary" : "Decimal",
        onChange: (_, index) => {
          radix = radixSelect[index];
        }
      });
  
      const buttonRow = new Div(dialog.body, {
        style: 'width: 100%; margin-top: 20px;',
      });
  
      const self = this;

      new Button(buttonRow, {
        label: 'Apply',
        style: 'margin-left: 15px; auto;',
        callback: function () {
          dialog.close();
          const type = resourceType(resource);
          self._setBufferFormat(resource.type, type.name, nameEdit.value, false, radix);
          bufferDataUI.html = "";
          const newType = resourceType(resource);
          self._showBufferDataType(bufferDataUI, newType, bufferData);
        }
      });

      new Button(buttonRow, {
        label: 'Revert',
        style: 'margin-left: 15px; auto;',
        callback: function () {
          resource.type.replacement = null;
          dialog.close();
          bufferDataUI.html = "";
          self._showBufferDataType(bufferDataUI, resource.type, bufferData);
        }
      });

      new Button(buttonRow, {
        label: 'Cancel',
        style: 'margin-left: 15px; auto;',
        callback: function () {
          dialog.close();
        }
      });
    } });
  }

  _showBufferDataInfo(parentWidget, resource, bufferData) {
    function resourceType(resource) {
      return resource.type.replacement || resource.type;
    }

    if (resource.resourceType === ResourceType.Uniform) {
      const typeName = this._getTypeName(resource.type);
      new Div(parentWidget, { text: `UNIFORM: ${resource.name}: ${typeName}` });

      const bufferDataUI = new Div(null);
      this._createFormatButton(parentWidget, resource, bufferDataUI, bufferData)
      bufferDataUI.parent = parentWidget;

      this._showBufferDataType(bufferDataUI, resourceType(resource), bufferData);
    } else if (resource.resourceType === ResourceType.Storage) {
      const typeName = this._getTypeName(resource.type);
      new Div(parentWidget, { text: `STORAGE ${resource.access}: ${resource.name}: ${typeName}` });
      
      const bufferDataUI = new Div(null);
      this._createFormatButton(parentWidget, resource, bufferDataUI, bufferData)
      bufferDataUI.parent = parentWidget;

      this._showBufferDataType(bufferDataUI, resourceType(resource), bufferData);
    }
  }

  _findBindingResourceFromState(state, group, binding) {
    if (!state) {
      return null;
    }

    const id = state.pipeline?.args[0].__id;
    const pipeline = this._getObject(id);

    if (pipeline) {
      const desc = pipeline.descriptor;
      const vertexId = desc.vertex?.module?.__id;
      const fragmentId = desc.fragment?.module?.__id;
      const computeId = desc.compute?.module?.__id;
      if (computeId) {
        const module = this._getObject(computeId);
        if (module?.reflection) {
          const resource = module.reflection.findResource(group, binding);
          if (resource) {
            return resource;
          }
        }
      } else if (vertexId !== undefined && vertexId === fragmentId) {
        const module = this._getObject(vertexId);
        if (module?.reflection) {
          const resource = module.reflection.findResource(group, binding);
          if (resource) {
            return resource;
          }
        }
      } else {
        const vertexModule = this._getObject(vertexId);
        if (vertexModule?.reflection) {
          const resource = vertexModule.reflection.findResource(group, binding);
          if (resource) {
            return resource;
          }
        }

        const fragmentModule = this._getObject(fragmentId);
        if (fragmentModule?.reflection) {
          const resource = fragmentModule.reflection.findResource(group, binding);
          if (resource) {
            return resource;
          }
        }
      }
    }

    return null;
  }

  _showBufferData(parentWidget, groupIndex, entryIndex, bindGroup, state, bufferData) {
    new Div(parentWidget, { text: `Group ${groupIndex} Binding ${entryIndex} Size: ${bufferData.length}` });

    const resource = this._findBindingResourceFromState(state, groupIndex, entryIndex);
    if (resource) {
      this._showBufferDataInfo(parentWidget, resource, bufferData);
    }
  }

  _showCaptureCommandInfo_setBindGroup(command, commandInfo, groupIndex, skipInputs, state, commands) {
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

    function getBindingAccess(state, group, binding) {
      if (state) {
        const pipelineId = state.pipeline?.args[0].__id;
        const pipeline = self._getObject(pipelineId);
        if (pipeline) {
          const desc = pipeline.descriptor;
          const vertexId = desc.vertex?.module?.__id;
          const fragmentId = desc.fragment?.module?.__id;
          const computeId = desc.compute?.module?.__id;
          if (computeId) {
            const module = self._getObject(computeId);
            if (module) {
              const reflection = module.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == group && storage.binding == binding) {
                    return storage.access;
                  }
                }
              }
            }
          } else if (vertexId !== undefined && vertexId === fragmentId) {
            const module = self._getObject(vertexId);
            if (module) {
              const reflection = module.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == group && storage.binding == binding) {
                    return storage.access;
                  }
                }
              }
            }
          } else {
            const vertexModule = self._getObject(vertexId);
            if (vertexModule) {
              const reflection = vertexModule.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == group && storage.binding == binding) {
                    return storage.access;
                  }
                }
              }
            }

            const fragmentModule = self._getObject(fragmentId);
            if (fragmentModule) {
              const reflection = fragmentModule.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == group && storage.binding == binding) {
                    return storage.access;
                  }
                }
              }
            }
          }
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

      let access = getBindingAccess(state, groupIndex, binding);
      /*if (state) {
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
      }*/

      let size = null;
      if (resource.buffer) {
        if (bindGroupCmd?.isBufferDataLoaded) {
          if (bindGroupCmd.isBufferDataLoaded[entryIndex]) {
            const bufferData = bindGroupCmd.bufferData[entryIndex];
            if (bufferData) {
              size = bufferData.length;
            }
          }
        }
      }

      let label = `${groupLabel}Binding ${binding}: ${getResourceType(resource)} ID:${getResourceId(resource)} ${getResourceUsage(resource)}`;

      if (access) {
        label += ` ${access}`;
      }

      if (size) {
        label += ` Size: ${size}`;
      }

      if (resource.buffer) {
        const binding = this._findBindingResourceFromState(state, groupIndex, entryIndex);
        if (binding) {
          const typeName = this._getTypeName(binding.type);
          if (typeName) {
            label += ` Type: ${typeName}`;
          }
        }
      }

      const resourceGrp = new Collapsable(commandInfo, { collapsed: true, label });
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

          const affectedByCommands = [];
          let commandIndex = this._captureCommands.indexOf(command);
          if (commandIndex !== -1) {
            commandIndex--;
            for (; commandIndex >= 0; --commandIndex) {
              const cmd = this._captureCommands[commandIndex];
              if (cmd.method === "writeBuffer") {
                if (cmd.args[0].__id === bufferId) {
                  affectedByCommands.push(cmd);
                }
              } else if (cmd.method === "createBuffer") {
                if (cmd.result.__id === bufferId) {
                  affectedByCommands.push(cmd);
                }
              } else if (cmd.method === "dispatchWorkgroups" || cmd.method === "dispatchWorkgroupsIndirect") {
                const cmdState = this._getPipelineState(cmd, commands);
                if (cmdState) {
                  for (const bindGroupCmd of cmdState.bindGroups) {
                    const groupIndex = bindGroupCmd.args[0];
                    const bindGroup = this.database.getObject(bindGroupCmd.args[1].__id);
                    if (bindGroup) {
                      const bindGroupDesc = bindGroup.descriptor;
                      for (const entry of bindGroupDesc.entries) {
                        if (entry.resource?.buffer?.__id === bufferId) {
                          const access = getBindingAccess(cmdState, groupIndex, entry.binding);
                          if (access === "write" || access === "read_write") {
                            affectedByCommands.push(cmd);
                          }
                          break;
                        }
                      }
                    }
                  }
                }
              }
            }

            if (affectedByCommands.length) {
              new Div(resourceGrp.body, { text: "Affected by:" });
              const ul = new Widget("ul", resourceGrp.body);
              for (const cmd of affectedByCommands) {
                const li = new Widget("li", ul, { text: `${cmd.id}: ${cmd.method}` });
                li.element.onclick = () => {
                  cmd.widget.element.click();
                };
              }
            }
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
          const vertexEntry = desc.vertex?.entryPoint ?? "@vertex";
          const fragmentEntry = desc.fragment?.entryPoint ?? "@fragment";
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
            const vertexEntry = desc.vertex?.entryPoint ?? "@vertex";
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
            const fragmentEntry = desc.fragment?.entryPoint ?? "@fragment";
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

      if (command.isBufferDataLoaded && command.bufferData) {
        const bufferData = command.bufferData[0];
        if (bufferData) {
          const indexArray = args[1] === "uint32" ? new Uint32Array(bufferData.buffer, bufferData.byteOffset, bufferData.byteLength / 4)
              : new Uint16Array(bufferData.buffer, bufferData.byteOffset, bufferData.byteLength / 2);
          new Div(bufferGrp.body, { text: `Index Buffer: ${buffer.name}(${buffer.id}) Format:${indexArray instanceof Uint32Array ? "uint32" : "uint16"} Count:${indexArray.length}` });
          const button = new Button(bufferGrp.body, { label: "Show Data", callback: () => {
            if (button.element.innerText === "Hide Data") {
              button.element.innerText = "Show Data";
              bufferGrp.body.removeChild(bufferGrp.body.lastChild);
              return;
            }
            button.element.innerText = "Hide Data";
            const ol = new Widget("ol", bufferGrp.body);
            for (const index of indexArray) {
              new Widget("li", ol, { text: `${index}` });
            }
          } });
        }
      }
    }
  }

  _showCaptureCommandInfo_setVertexBuffer(command, commandInfo, collapsed, state) {
    const args = command.args;
    const self = this;
    const index = args[0];
    const id = args[1]?.__id;
    const buffer = this._getObject(id);

    let input = null;
    const pipeline = this._getObject(state?.pipeline?.args[0].__id);
    if (pipeline) {
      const desc = pipeline.descriptor;
      const vertexId = desc?.vertex?.module?.__id;
      const vertexShader = this._getObject(vertexId);
      const reflection = vertexShader?.reflection;
      const inputs = reflection?.entry.vertex[0]?.inputs;
      if (inputs) {
        input = inputs[index];
      }
    }

    if (buffer) {
      const bufferGrp = new Collapsable(commandInfo, { collapsed, label: `Vertex Buffer ${index} ID:${id} ${input?.name ?? ""}` });
      new Button(bufferGrp.body, { label: "Inspect", callback: () => {
        self.window.inspectObject(buffer);
      } });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });

      if (input && command.isBufferDataLoaded && command.bufferData) {
        const bufferData = command.bufferData[index];
        if (bufferData) {
          const button = new Button(bufferGrp.body, { label: "Show Data", callback: () => {
            if (button.element.innerText === "Hide Data") {
              button.element.innerText = "Show Data";
              bufferGrp.body.removeChild(bufferGrp.body.lastChild);
              return;
            }
            button.element.innerText = "Hide Data";
            const count = bufferData.length / input.type.size;
            const stride = input.type.size;
            const type = { name: "array", count, stride, format: input.type };
            self._showBufferDataType(bufferGrp.body, type, bufferData);
          } });
        }
      }
    }
  }

  _getPipelineState(command) {
    const commands = command.object?.commands || (this._passEncoderCommands.get(command.object) ?? null);
    if (commands === null) {
      return null;
    }
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
    if (!t) {
      return "";
    }
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
    if (!state) {
      return;
    }

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true, state);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  _showCaptureCommandInfo_drawIndexed(command, commandInfo) {
    const state = this._getPipelineState(command);
    if (!state) {
      return;
    }

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    if (state.indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true, state);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  _showCaptureCommandInfo_indirectBuffer(command, indirectBuffer, indirectOffset, commandInfo, collapsed) {
    const id = indirectBuffer.__id;
    const buffer = this._getObject(id);
    if (buffer) {
      const self = this;
      const bufferGrp = new Collapsable(commandInfo, { collapsed, label: `Indirect Buffer ID:${id} ${buffer.label}` });
      new Button(bufferGrp.body, { label: "Inspect", callback: () => {
        self.window.inspectObject(buffer);
      } });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });

      if (command.isBufferDataLoaded && command.bufferData) {
        const bufferData = command.bufferData[0];
        if (bufferData) {
          const u32Array = new Uint32Array(bufferData.buffer, indirectOffset);
          if (command.method === "dispatchWorkgroupsIndirect") {
            new Div(bufferGrp.body, { text: `Workgroup Count X: ${u32Array[0]}` });
            new Div(bufferGrp.body, { text: `Workgroup Count Y: ${u32Array[1]}` });
            new Div(bufferGrp.body, { text: `Workgroup Count Z: ${u32Array[2]}` });
          } else if (command.method === "drawIndexedIndirect") {
            new Div(bufferGrp.body, { text: `Index Count: ${u32Array[0]}` });
            new Div(bufferGrp.body, { text: `Instance Count: ${u32Array[1]}` });
            new Div(bufferGrp.body, { text: `First Index: ${u32Array[2]}` });
            new Div(bufferGrp.body, { text: `Base Vertex: ${u32Array[3]}` });
            new Div(bufferGrp.body, { text: `First Instance: ${u32Array[4]}` });
          } else if (command.method === "drawIndirect") {
            new Div(bufferGrp.body, { text: `Vertex Count: ${u32Array[0]}` });
            new Div(bufferGrp.body, { text: `Instance Count: ${u32Array[1]}` });
            new Div(bufferGrp.body, { text: `First Index: ${u32Array[2]}` });
            new Div(bufferGrp.body, { text: `First Instance: ${u32Array[3]}` });
          }
        }
      }
    }
  }

  _showCaptureCommandInfo_drawIndirect(command, commandInfo) {
    const state = this._getPipelineState(command);

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    this._showCaptureCommandInfo_indirectBuffer(command, command.args[0], command.args[1], commandInfo, true);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true, state);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  _showCaptureCommandInfo_drawIndexedIndirect(command, commandInfo) {
    const state = this._getPipelineState(command);

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    this._showCaptureCommandInfo_indirectBuffer(command, command.args[0], command.args[1], commandInfo, true);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, true);
    }
    if (state.indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true, state);
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

  _showCaptureCommandInfo_dispatchWorkgroupsIndirect(command, commandInfo) {
    this._showCaptureCommandInfo_indirectBuffer(command, command.args[0], command.args[1], commandInfo, true, true);

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

  _showCaptureCommandInfo_executeBundles(command, commandInfo) {
    const bundles = command.args[0];
    for (const bundleId of bundles) {
      const bundle = this._getObject(bundleId.__id);
      if (!bundle) {
        continue;
      }
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

  _showCaptureCommandInfo(command, name, commandInfo, showHeader = true) {
    commandInfo.html = "";

    const method = command.method;
    const args = command.args;

    if (showHeader) {
      new Div(commandInfo, { text: `${name} ${method}`, style: "background-color: #575; padding-left: 20px; line-height: 40px;" });
    }

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
    } else if (method === "draw" || method === "drawIndexed" || method === "drawIndirect" || method === "drawIndexedIndirect") {
      const state = this._getPipelineState(command);
      if (state.pipeline) {
        const topology = this._getObject(state.pipeline.args[0].__id)?.topology ?? "triangle-list";

        let vertexCount = 0;
        if (method === "drawIndirect" || method === "drawIndexedIndirect") {
          if (command.isBufferDataLoaded && command.bufferData) {
            const bufferData = command.bufferData[0];
            if (bufferData) {
              const u32Array = new Uint32Array(bufferData.buffer);
              vertexCount = u32Array[0];
            }
          }
        } else {
          vertexCount = args[0] ?? 0;
        }

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
    } else if (method === "dispatchWorkgroupsIndirect") {
        this._showCaptureCommandInfo_dispatchWorkgroupsIndirect(command, commandInfo);
    } else if (method === "end") {
      this._showCaptureCommandInfo_end(command, commandInfo);
    } else if (method === "createView") {
      this._showCaptureCommandInfo_createView(command, commandInfo);
    } else if (method === "executeBundles") {
      this._showCaptureCommandInfo_executeBundles(command, commandInfo);
    }
  }

  _textureDataChunkLoaded() {
    if (this._captureData) {
      this._captureData.captureTextureDataChunk();
      this._updateCaptureStatus();
    }
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
    if (!this._captureData) {
      return;
    }

    this._captureData.captureTextureLoaded();

    if (this._lastSelectedCommand) {
      this._lastSelectedCommand.element.click();
    }

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
