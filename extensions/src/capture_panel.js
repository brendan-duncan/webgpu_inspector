import { Button } from "./widget/button.js";
import { Collapsable } from "./widget/collapsable.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Widget } from "./widget/widget.js";
import { getFlagString } from "./flags.js";
import {
  Sampler,
  TextureView
 } from "./object_database.js";

export class CapturePanel {
  constructor(window, parent) {
    this.window = window;

    const self = this;
    const port = window.port;

    const controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    new Button(controlBar, { label: "Capture", style: "background-color: #557;", callback: () => { 
      try {
        self.port.postMessage({ action: "inspector_capture" });
      } catch (e) {}
    } });

    this._captureFrame = new Span(controlBar, { text: ``, style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });

    this._capturePanel = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-100px + 100vh); display: flex;" });

    window.onTextureLoaded.addListener(this._textureLoaded, this);

    port.addListener((message) => {
      switch (message.action) {
        case "inspect_capture_frame_results": {
          const commands = message.commands;
          const frame = message.frame;
          self._captureFrameResults(frame, commands);
          break;
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
        return `${obj.constructor.name} ID:${object.__id}`;
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
      if (method == "draw" || method == "drawIndexed" || method == "drawIndirect" || method == "drawIndexedIndirect" ||
          method == "dispatchWorkgroups" || method == "dispatchWorkgroupsIndirect") {
        cmdType.push("capture_drawcall");
      }

      const cmd = new Div(currentPass, { class: cmdType });
      if (method == "beginRenderPass") {
        cmd.element.id = `RenderPass_${renderPassIndex - 1}_begin`;
      }
      new Span(cmd, { class: "capture_callnum", text: `${commandIndex}.` });
      new Span(cmd, { class: "capture_methodName", text: `${method}` });

      if (method === "setViewport") {
        new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]} minZ:${args[4]} maxZ:${args[5]}` });
      } else if (method === "setScissorRect") {
        new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]}` });
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
        context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
        const canvasTexture = context.getCurrentTexture();
        this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
      } else {
        const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: ${format}` });
        new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(depthStencilAttachment.view.descriptor, undefined, 4) });
        const texDesc = this._processCommandArgs(texture.descriptor);
        if (texDesc.usage) {
          texDesc.usage = getFlagString(texDesc.usage, GPUTextureUsage);
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
        context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
        const canvasTexture = context.getCurrentTexture();
        this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
      } else {
        const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment: ${texture?.descriptor?.format ?? "<unknown format>"}` });
        new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(depthStencilAttachment.view.descriptor, undefined, 4) });
        const texDesc = this._processCommandArgs(texture.descriptor);
        if (texDesc.usage) {
          texDesc.usage = getFlagString(texDesc.usage, GPUTextureUsage);
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

  _showCaptureCommandInfo_dispatchWorkgroups(args, commandInfo, commandIndex, commands) {
    let pipeline = null;
    let vertexBuffer = null;
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