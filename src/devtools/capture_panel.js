import { Button } from "./widget/button.js";
import { Collapsable } from "./widget/collapsable.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Widget } from "./widget/widget.js";
import { getFlagString } from "../utils/flags.js";
import { CaptureStatistics } from "./capture_statistics.js";
import {
  Sampler,
  TextureView
} from "./object_database.js";

export class CapturePanel {
  constructor(window, parent) {
    this.window = window;

    const self = this;
    const port = window.port;

    this.statistics = new CaptureStatistics();

    const controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    new Button(controlBar, { label: "Capture", style: "background-color: #557;", callback: () => { 
      try {
        self.port.postMessage({ action: "inspector_capture" });
      } catch (e) {}
    } });

    this._captureFrame = new Span(controlBar, { style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
    this._captureStats = new Button(controlBar, { label: "Frame Stats", style: "display: none;" });
    this._captureStatus = new Span(controlBar, { style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });

    this._capturePanel = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-100px + 100vh); display: flex;" });

    window.onTextureLoaded.addListener(this._textureLoaded, this);

    this._loadingImages = 0;

    this._captureCommands = [];
    this._catpureFrameIndex = 0;
    this._captureCount = 0;

    port.addListener((message) => {
      switch (message.action) {
        case "inspect_capture_texture_frames": {
          self._loadingImages = message.count ?? 0;
          self._captureStatus.text = `Loading Images: ${self._loadingImages}`;
          break;
        }
        case "inspect_capture_frame_results": {
          const frame = message.frame;
          const count = message.count;
          const batches = message.batches;
          self._captureCommands.length = count;
          self._catpureFrameIndex = frame;
          self._captureCount = batches;
          break;
        }
        case "inspect_capture_frame_commands": {
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
        }
      }
    });
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
      const obj = this.database.getObject(object.__id);
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

    this._frameImages = new Span(contents, { class: "capture_frameImages" });
    const frameContents = new Span(contents, { class: "capture_frame" });
    const commandInfo = new Span(contents, { class: "capture_commandInfo" });
    
    const self = this;
    this._captureStats.callback = () => {
      self._inspectStats(commandInfo);
    };
    
    let renderPassIndex = 0;

    const debugGroupStack = [frameContents];
    const debugGroupLabelStack = [];
    let debugGroupIndex = 0;

    let currentBlock = new Div(frameContents, { class: "capture_commandBlock" });

    this._lastSelectedCommand = null;

    const stats = this.statistics;
    stats.reset();

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
        currentBlock = new Div(debugGroup, { class: "capture_renderpass" });
        new Div(currentBlock, { text: `Render Pass ${renderPassIndex}`, id: `RenderPass_${renderPassIndex}`, style: "padding-left: 20px; font-size: 12pt; color: #ddd; margin-bottom: 5px; background-color: #553; line-height: 30px;" });
        renderPassIndex++;
      } else if (method === "beginComputePass") {
        currentBlock = new Div(debugGroup, { class: "capture_computepass" });
      } else if (method === "popDebugGroup") {
        debugGroupStack.pop();
        debugGroup = debugGroupStack[debugGroupStack.length - 1];
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      }

      const cmdType = ["capture_command"];
      if (method === "draw" || method === "drawIndexed" || method === "drawIndirect" || method === "drawIndexedIndirect" ||
          method === "dispatchWorkgroups" || method == "dispatchWorkgroupsIndirect") {
        cmdType.push("capture_drawcall");
      }

      const cmd = new Div(currentBlock, { class: cmdType });
      if (method == "beginRenderPass") {
        cmd.element.id = `RenderPass_${renderPassIndex - 1}_begin`;
      }
      new Span(cmd, { class: "capture_callnum", text: `${commandIndex}.` });
      new Span(cmd, { class: "capture_methodName", text: `${method}` });

      if (method === "setViewport") {
        new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]} minZ:${args[4]} maxZ:${args[5]}` });
      } else if (method === "setScissorRect") {
        new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]}` });
      } else if (method === "setStencilReference") {
        new Span(cmd, { class: "capture_method_args", text: `reference:${args[0]}` });
      } else if (method === "setBindGroup") {
        new Span(cmd, { class: "capture_method_args", text: `index:${args[0]} bindGroup:${args[1].__id}` });
      } else if (method === "writeBuffer") {
        const data = args[2];
        if (data.constructor === String) {
          const s = data.split(" ")[2];
          new Span(cmd, { class: "capture_method_args", text: `buffer:${args[0].__id} offset:${args[1]} data:${s} Bytes` });
        } else {
          new Span(cmd, { class: "capture_method_args", text: `buffer:${args[0].__id} offset:${args[1]} data:${args[2].length} Bytes` });
        }
      } else if (method === "setPipeline") {
        new Span(cmd, { class: "capture_method_args", text: `renderPipeline:${args[0].__id}` });
      } else if (method === "setVertexBuffer") {
        new Span(cmd, { class: "capture_method_args", text: `slot:${args[0]} buffer:${args[1].__id} offset:${args[2] ?? 0}` });
      } else if (method === "setIndexBuffer") {
        new Span(cmd, { class: "capture_method_args", text: `buffer:${args[0].__id} indexFormat:${args[1]} offset:${args[2] ?? 0}` });
      } else if (method === "drawIndexed") {
        new Span(cmd, { class: "capture_method_args", text: `indexCount:${args[0]} instanceCount:${args[1] ?? 1} firstIndex:${args[2] ?? 0} baseVertex:${args[3] ?? 0} firstInstance:${args[4] ?? 0}` });
      } else if (method === "draw") {
        new Span(cmd, { class: "capture_method_args", text: `vertexCount:${args[0]} instanceCount:${args[1] ?? 1} firstVertex:${args[2] ?? 0} firstInstance:${args[3] ?? 0}` });
      } else if (method === "dispatchWorkgroups") {
        new Span(cmd, { class: "capture_method_args", text: `countX:${args[0]} countY:${args[1] ?? 1} countZ:${args[2] ?? 1}` });
      } else if (method === "dispatchWorkgroupsIndirect") {
        new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${args[0].__id} offset:${args[1]}` });
      } else if (method === "pushDebugGroup") {
        new Span(cmd, { class: "capture_method_args", text: args[0] });
        debugGroupLabelStack.push(args[0]);
      } else if (method === "popDebugGroup") {
        const label = debugGroupLabelStack.pop();
        new Span(cmd, { class: "capture_method_args", text: label });
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

  _getTextureFromView(view) {
    if (view.__texture) {
      return view.__texture;
    }
    if (view.texture) {
      view.__texture = this.database.getObject(view.texture);
    }
    return view.__texture;
  }

  _getTextureFromAttachment(attachment) {
    if (!attachment.view) {
      return null;
    }
    const view = this.database.getObject(attachment.view.__id);
    if (!view) {
      return null;
    }
    return this._getTextureFromView(view);
  }

  _showCaptureCommandInfo_beginRenderPass(args, commandInfo) {
    const colorAttachments = args[0].colorAttachments;
    for (const i in colorAttachments) {
      const attachment = colorAttachments[i];
      const texture = this._getTextureFromAttachment(attachment);

      if (texture) {
        const format = texture.descriptor.format;
        if (texture.gpuTexture) {
          const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: ${format} ${texture.width}x${texture.height}` });

          const viewWidth = 256;
          const viewHeight = Math.round(viewWidth * (texture.height / texture.width));
          const canvas = new Widget("canvas", colorAttachmentGrp, { style: "margin-left: 20px; margin-top: 10px;" });
          canvas.element.width = viewWidth;
          canvas.element.height = viewHeight;
          const context = canvas.element.getContext('webgpu');
          const dstFormat = navigator.gpu.getPreferredCanvasFormat();
          context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
          const canvasTexture = context.getCurrentTexture();
          this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
        } else {
          const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: ${format} ${texture.width}x${texture.height}` });
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
          const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment ${format} ${texture.width}x${texture.height}` });
          const viewWidth = 256;
          const viewHeight = Math.round(viewWidth * (texture.height / texture.width));
          const canvas = new Widget("canvas", depthStencilAttachmentGrp, { style: "margin-left: 20px; margin-top: 10px;" });
          canvas.element.width = viewWidth;
          canvas.element.height = viewHeight;
          const context = canvas.element.getContext('webgpu');
          const dstFormat = navigator.gpu.getPreferredCanvasFormat();
          context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
          const canvasTexture = context.getCurrentTexture();
          this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
        } else {
          const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment: ${texture?.descriptor?.format ?? "<unknown format>"} ${texture.width}x${texture.height}` });
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

  _showCaptureCommandInfo_setBindGroup(args, commandInfo, index, collapsed) {
    const id = args[1].__id;
    const bindGroup = this.database.getObject(id);
    if (bindGroup) {
      const bindGroupGrp = new Collapsable(commandInfo, { collapsed: true, label: `BindGroup ${index ?? ""} ID:${id}` });
      const bindGroupDesc = bindGroup.descriptor;
      const newDesc = this._processCommandArgs(bindGroupDesc);
      const descStr = JSON.stringify(newDesc, undefined, 4);
      new Widget("pre", bindGroupGrp.body, { text: descStr });

      const self = this;
      function getResourceType(resource) {
        if (resource.__id !== undefined) {
          const obj = self.database.getObject(resource.__id);
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

      for (const entry of bindGroupDesc.entries) {
        const binding = entry.binding;
        const resource = entry.resource;
        const groupLabel = index !== undefined ? `Group ${index} ` : "";
        const resourceGrp = new Collapsable(commandInfo, { collapsed: true, label: `${groupLabel}Binding ${binding}: ${getResourceType(resource)} ID:${getResourceId(resource)}` });
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
                context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
                const canvasTexture = context.getCurrentTexture();
                this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
              } else {
                new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
                new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
                if (texture) {
                  new Div(resourceGrp.body, { text: `GPUTexture ID:${texture.id}` });
                  const newDesc = this._processCommandArgs(texture.descriptor);
                  if (newDesc.usage) {
                    newDesc.usage = getFlagString(newDesc.usage, GPUTextureUsage);
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
                newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
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
      const pipelineGrp = new Collapsable(commandInfo, { collapsed: true, label: `Pipeline ID:${id}` });
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
          const grp = new Collapsable(commandInfo, { collapsed: true, label: `Module ID:${vertexId} Vertex: ${vertexEntry} Fragment: ${fragmentEntry}` });
          const code = module.descriptor.code;
          new Widget("pre", grp.body, { text: code });

          this._shaderInfo("Vertex+Fragment", module, commandInfo);
        }
      } else {
        if (vertexId !== undefined) {
          const vertexModule = this.database.getObject(vertexId);
          if (vertexModule) {
            const vertexEntry = desc.vertex?.entryPoint;

            const vertexGrp = new Collapsable(commandInfo, { collapsed: true, label: `Vertex Module ID:${vertexId} Entry: ${vertexEntry}` });
            const code = vertexModule.descriptor.code;
            new Widget("pre", vertexGrp.body, { text: code });

            this._shaderInfo("Vertex", vertexModule, commandInfo);
          }
        }
        
        if (fragmentId !== undefined) {
          const fragmentModule = this.database.getObject(fragmentId);
          if (fragmentModule) {
            const fragmentEntry = desc.fragment?.entryPoint;
            const fragmentGrp = new Collapsable(commandInfo, { collapsed: true, label: `Fragment Module ID:${fragmentId} Entry: ${fragmentEntry}` });
            const code = fragmentModule.descriptor.code;
            new Widget("pre", fragmentGrp.body, { text: code });

            this._shaderInfo("Fragment", fragmentModule, commandInfo);
          }
        }
      }

      const computeId = desc.compute?.module?.__id;
      if (computeId !== undefined) {
        const computeModule = this.database.getObject(computeId);
        if (computeModule) {
          const computeEntry = desc.compute?.entryPoint;
          const computeGrp = new Collapsable(commandInfo, { collapsed: true, label: `Compute Module ID:${computeId} Entry: ${computeEntry}` });
          const code = computeModule.descriptor.code;
          new Widget("pre", computeGrp.body, { text: code });

          this._shaderInfo("Compute", computeModule, commandInfo);
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
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
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
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
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
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
    }
  }

  _getDrawState(commandIndex, commands) {
    let pipeline = null;
    let vertexBuffer = null;
    let indexBuffer = null;
    let bindGroups = [];
    for (let ci = commandIndex - 1; ci >= 0; --ci) {
      const cmd = commands[ci];
      if (cmd.method === "beginRenderPass") {
        break;
      }
      if (cmd.method === "setIndexBuffer" && !indexBuffer) {
        indexBuffer = cmd;
      }
      if (cmd.method === "setVertexBuffer" && !vertexBuffer) {
        vertexBuffer = cmd;
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

    return { pipeline, vertexBuffer, indexBuffer, bindGroups };
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

  _addStructMembers(l2, members) {
    new Widget("li", l2, { text: `Members:` });
    const l3 = new Widget("ul", l2);
    for (const m in members) {
      new Widget("li", l3, { text: `${s.type.members[m].name}: ${this._getTypeName(s.type.members[m].type)}` });
      const l4 = new Widget("ul", l3);
      new Widget("li", l4, { text: `Offset: ${members[m].offset}` });
      new Widget("li", l4, { text: `Size: ${members[m].size}` });

      if (m.type.name === "array") {
        new Widget("li", l4, { text: `Array Count: ${members[m].count}` });
        if (m.type.format?.members) {
          this._addStructMembers(l3, f.format.members);
        }
      }
    }
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

  _shaderInfo(type, shader, commandInfo) {
    const reflect = shader.reflection;
    if (reflect) {
      const grp = new Collapsable(commandInfo, { collapsed: true, label: `${type} Shader Info` });
      grp.body.style.maxHeight = "600px";
      
      if (reflect.uniforms.length) {
        new Div(grp.body, { text: `Uniform Buffers: ${reflect.uniforms.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.uniforms) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
          new Widget("li", l2, { text: `Buffer Size: ${s.type.size || "<runtime>"}` });
          
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
          new Widget("li", l2, { text: `Buffer Size: ${s.type.size || "<runtime>"}` });

          this._addShaderTypeInfo(l2, s.type);
        }
      }
      
      /*
      new Div(grp.body, { text: `Textures: ${reflect.textures.length}` });
      for (const texture of reflect.textures) {
        new Widget("pre", grp.body, { text: JSON.stringify(texture, null, 4) });
      }
      new Div(grp.body, { text: `Samplers: ${reflect.samplers.length}` });
      for (const sampler of reflect.samplers) {
        new Widget("pre", grp.body, { text: JSON.stringify(sampler, null, 4) });
      }*/
    }
  }

  _showCaptureCommandInfo_draw(args, commandInfo, commandIndex, commands) {
    const state = this._getDrawState(commandIndex, commands);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline.args, commandInfo, true);
    }
    if (state.vertexBuffer) {
      this._showCaptureCommandInfo_setVertexBuffer(state.vertexBuffer.args, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index].args, commandInfo, index, true);
    }
  }

  _showCaptureCommandInfo_drawIndexed(args, commandInfo, commandIndex, commands) {
    const state = this._getDrawState(commandIndex, commands);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline.args, commandInfo, true);
    }
    if (state.indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer.args, commandInfo, true);
    }
    if (state.vertexBuffer) {
      this._showCaptureCommandInfo_setVertexBuffer(state.vertexBuffer.args, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index].args, commandInfo, index, true);
    }
  }

  _showCaptureCommandInfo_drawIndirect(args, commandInfo, commandIndex, commands) {
    const state = this._getDrawState(commandIndex, commands);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline.args, commandInfo, true);
    }
    if (state.vertexBuffer) {
      this._showCaptureCommandInfo_setVertexBuffer(state.vertexBuffer.args, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index].args, commandInfo, index, true);
    }
  }

  _showCaptureCommandInfo_drawIndexedIndirect(args, commandInfo, commandIndex, commands) {
    const state = this._getDrawState(commandIndex, commands);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline.args, commandInfo, true);
    }
    if (state.indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer.args, commandInfo, true);
    }
    if (state.vertexBuffer) {
      this._showCaptureCommandInfo_setVertexBuffer(state.vertexBuffer.args, commandInfo, true);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index].args, commandInfo, index, true);
    }
  }

  _showCaptureCommandInfo_dispatchWorkgroups(args, commandInfo, commandIndex, commands) {
    let pipeline = null;
    let bindGroups = [];
    for (let ci = commandIndex - 1; ci >= 0; --ci) {
      const cmd = commands[ci];
      if (cmd.method == "beginComputePass") {
        break;
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
    for (const index in bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
    }
  }

  _inspectStats(commandInfo) {
    commandInfo.html = "";

    const group = new Collapsable(commandInfo, { label: "Frame Statistics" });
    group.body.style.maxHeight = "unset";

    const ol = new Widget("ul", group.body);
    const stats = this.statistics;
    for (const key in stats) {
      new Widget("li", ol, { text: `${key}: ${stats[key].toLocaleString("en-US")}`, style: "padding-left: 20px; line-height: 25px; font-size: 12pt;" });
    }
  }

  _showCaptureCommandInfo(name, method, args, commandInfo, commandIndex, commands) {
    commandInfo.html = "";

    new Div(commandInfo, { text: `${name} ${method}`, style: "background-color: #575; padding-left: 20px; line-height: 40px;" });

    if (method === "beginRenderPass") {
      const desc = args[0];
      const colorAttachments = desc.colorAttachments;
      for (const i in colorAttachments) {
        const attachment = colorAttachments[i];
        const textureView = this.database.getObject(attachment.view.__id);
        const texture = this._getTextureFromView(textureView);
        if (texture) {
          const format = texture.descriptor.format;
          new Div(commandInfo, { text: `Color ${i}: ${format} ${texture.width}x${texture.height}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        }
      }
      const depthStencilAttachment = desc.depthStencilAttachment;
      if (depthStencilAttachment) {
        const textureView = this.database.getObject(depthStencilAttachment.view.__id);
        const texture = this._getTextureFromView(textureView);
        if (texture) {
          const format = texture.descriptor.format;
          new Div(commandInfo, { text: `Depth-Stencil: ${format} ${texture.width}x${texture.height}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        }
      }
    } else if (method === "draw") {
      const state = this._getDrawState(commandIndex, commands);
      if (state.pipeline) {
        const topology = this.database.getObject(state.pipeline.args[0].__id)?.topology ?? "triangle-list";
        const vertexCount = args[0] ?? 0;
        if (topology === "triangle-list") {
          new Div(commandInfo, { text: `Triangles: ${vertexCount / 3}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        } else if (topology === "triangle-strip") {
          new Div(commandInfo, { text: `Triangles: ${vertexCount - 2}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        } else if (topology === "point-list") {
          new Div(commandInfo, { text: `Points: ${vertexCount}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        } else if (topology === "line-list") {
          new Div(commandInfo, { text: `Lines: ${vertexCount / 2}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        } else if (topology === "line-strip") {
          new Div(commandInfo, { text: `Lines: ${vertexCount - 1}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
        }
      }
    }

    const cmd = commands[commandIndex];
    if (cmd.stacktrace) {
      const stacktrace = new Collapsable(commandInfo, { collapsed: true, label: "Stacktrace" });
      new Div(stacktrace.body, { text: cmd.stacktrace, style: "font-size: 10pt;color: #ddd;overflow: auto;background-color: rgb(51, 51, 85);box-shadow: #000 0 3px 5px;padding: 5px;padding-left: 10px;" })
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
    } else if (method == "dispatchWorkgroups") {
      this._showCaptureCommandInfo_dispatchWorkgroups(args, commandInfo, commandIndex, commands);
    }
  }

  _textureLoaded(texture, passId) {
    if (passId == -1) {
      return;
    }

    this._loadingImages--;
    if (this._loadingImages <= 0) {
      this._captureStatus.text = "";
      this._loadingImages = 0;
    } else {
      this._captureStatus.text = `Loading Images: ${this._loadingImages}`;
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
      context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
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
}

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
