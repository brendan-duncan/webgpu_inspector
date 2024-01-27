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

export class InspectorWindow extends Window {
  constructor(database, port, tabId) {
    super();

    this.port = port;
    this.tabId = tabId;
    this.database = database
    this.classList.add("main-window");
    this._selectedObject = null;

    this.adapter = null;
    this.device = null;

    const self = this;
    this.port.onDisconnect.addListener(() => {
      self.port = chrome.runtime.connect({ name: "webgpu-inspector-content" });
    });

    this._tabs = new TabWidget(this);

    const inspectorPanel = new Div();
    this._tabs.addTab("Inspect", inspectorPanel);

    const capturePanel = new Div(null);
    this._tabs.addTab("Capture", capturePanel);

    const recorderPanel = new Div(null);
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
    const controlBar = new Div(inspectorPanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    this.inspectButton = new Button(controlBar, { label: "Start", callback: () => { 
      try {
        self.database.reset();
        self._resetInspectorPanel();
        self.port.postMessage({ action: "initialize_inspector", tabId: self.tabId });
      } catch (e) {}
    } });

    const stats = new Span(controlBar, { style: "border-left: 1px solid #aaa; padding-left: 10px; margin-left: 20px; height: 20px; padding-top: 5px; color: #ddd;" });
    this.uiFrameTime = new Span(stats);
    this.uiFrameRenderPasses = new Span(stats, { style: "margin-left: 20px;" });
    this.uiTotalTextureMemory = new Span(stats, { style: "margin-left: 20px;" });
    this.uiTotalBufferMemory = new Span(stats, { style: "margin-left: 20px;" });

    this.inspectorGUI = new Div(inspectorPanel, { style: "overflow: auto; white-space: nowrap; height: calc(-85px + 100vh); display: flex;" });
  }

  _buildCapturePanel(capturePanel) {
    const self = this;

    const controlBar = new Div(capturePanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    new Button(controlBar, { label: "Capture", style: "background-color: #557;", callback: () => { 
      try {
        self.port.postMessage({ action: "inspector_capture", tabId: self.tabId });
      } catch (e) {}
    } });

    this._captureFrame = new Span(controlBar, { text: ``, style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });

    this._capturePanel = new Div(capturePanel, { style: "overflow: auto; white-space: nowrap; height: calc(-100px + 100vh);" });
  }

  _buildRecorderPanel(recorderPanel) {
    const self = this;
    const port = this.port;

    const recorderBar = new Div(recorderPanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 5px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; width: calc(-60px + 100vw);" });

    this.recordButton = new Button(recorderBar, { label: "Record", style: "background-color: #755;", callback: () => {
      const frames = self.recordFramesInput.value || 1;
      const filename = self.recordNameInput.value;
      self._recordingData.length = 0;
      self.port.postMessage({ action: "initialize_recorder", frames, filename, tabId: self.tabId });
    }});

    new Span(recorderBar, { text: "Frames:", style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
    this.recordFramesInput = new Input(recorderBar, { id: "record_frames", type: "number", value: 100 });

    new Span(recorderBar, { text: "Name:", style: "margin-left: 20px; margin-right: 10px;  vertical-align: middle;" });
    this.recordNameInput = new Input(recorderBar, { id: "record_frames", type: "text", value: "webgpu_record" });

    this._recordingData = [];

    this.recorderDataPanel = new Div(recorderPanel);

    port.onMessage.addListener((message) => {
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
        return `$${object.__id} ${obj.constructor.name}`;
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
    texture.gpuTexture = this.device.createTexture(texture.descriptor);

    const format = texture.descriptor.format;
    const formatInfo = TextureFormatInfo[format] ?? TextureFormatInfo["rgba8unorm"];
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

      const frameImages = this._frameImages;
      if (!frameImages) {
        return;
      }

      const aspect = texture.height / texture.width;
      const viewWidth = 256;
      const viewHeight = Math.round(viewWidth * aspect);

      new Div(frameImages, { text: `Render Pass ${passId}`, style: "font-size: 10pt; color: #ddd; margin-bottom: 5px;" });
      const canvas = new Widget("canvas", frameImages, { width: viewWidth, height: viewHeight });
      const context = canvas.element.getContext('webgpu');
      context.configure({"device":this.device, "format":navigator.gpu.getPreferredCanvasFormat()});
      const canvasTexture = context.getCurrentTexture();

      this.textureUtils.blitTexture(texture.gpuTexture.createView(), canvasTexture.createView(), format);
  }

  _captureFrameResults(frame, commands) {
    const contents = this._capturePanel;

    this._captureFrame.text = `Frame ${frame}`;

    contents.html = "";   

    this._frameImages = new Span(contents, { class: "capture_frameImages" });
    const frameContents = new Span(contents, { class: "capture_frame" });
    const commandInfo = new Span(contents, { class: "capture_commandInfo" });
    
    let currentPass = new Div(frameContents, { class: "capture_commandBlock" });
    let callNumber = 0;
    let renderPassIndex = 0;

    for (const command of commands) {
      const className = command.class;
      //const id = command.id;
      const method = command.method;
      const args = command.args;
      const name = `${className ?? "__"}`;

      if (method == "beginRenderPass") {
        currentPass = new Div(frameContents, { class: "capture_renderpass" });
        new Div(currentPass, { text: `Render Pass ${renderPassIndex}`, style: "padding-left: 20px; font-size: 12pt; color: #ddd; margin-bottom: 5px; background-color: #553; line-height: 30px;" });
        renderPassIndex++;
      } else if (method == "beginComputePass") {
        currentPass = new Div(frameContents, { class: "capture_computepass" });
      }

      const cmdType = ["capture_command"];
      if (method == "draw" || method == "drawIndexed" || method == "drawIndirect" || method == "drawIndexedIndirect") {
        cmdType.push("capture_drawcall");
      }

      const cmd = new Div(currentPass, { class: cmdType });
      cmd.html = cmd.innerHTML = `<span class='callnum'>${callNumber++}.</span> <span class='capture_methodName'>${method}</span>`;

      const self = this;
      cmd.element.onclick = () => {
        const newArgs = self._processCommandArgs(args);
        const argStr = JSON.stringify(newArgs, undefined, 4);

        commandInfo.html = "";

        new Div(commandInfo, { text: name, style: "background-color: #575; padding-left: 20px; line-height: 40px;" });

        if (method == "beginRenderPass") {
          const desc = args[0];
          const colorAttachments = desc.colorAttachments;
          const depthStencilAttachment = desc.depthStencilAttachment;
          for (const i in colorAttachments) {
            const attachment = colorAttachments[i];
            const textureView = self.database.getObject(attachment.view.__id);
            if (textureView) {
              const texture = textureView.parent;
              if (texture) {
                const format = texture.descriptor.format;
                new Div(commandInfo, { text: `Color Attachment ${i}: ${format}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
              }
            }
          }
        }

        new Widget("hr", commandInfo);
        new Widget("pre", commandInfo, { text: argStr });
      };

      if (method == "end") {
        currentPass = new Div(frameContents, { class: "capture_commandBlock" });
      }
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
    const objectsPanel = new Div(null, { style: "font-size: 11pt;"});
    objectsTab.addTab("Objects", objectsPanel);

    const pane3 = new Span(this.inspectorGUI, { style: "padding-left: 20px; flex-grow: 1; overflow: auto;" });

    const inspectTab = new TabWidget(pane3);
    this.inspectPanel = new Div(null, { style: "font-size: 14pt;"});
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
        let access = "";
        if (value & GPUBufferUsage.MAP_READ) {
          access += "MAP_READ ";
        }
        if (value & GPUBufferUsage.MAP_WRITE) {
          access += "MAP_WRITE ";
        }
        if (value & GPUBufferUsage.COPY_SRC) {
          access += "COPY_SRC ";
        }
        if (value & GPUBufferUsage.COPY_DST) {
          access += "COPY_DST ";
        }
        if (value & GPUBufferUsage.INDEX) {
          access += "INDEX ";
        }
        if (value & GPUBufferUsage.VERTEX) {
          access += "VERTEX ";
        }
        if (value & GPUBufferUsage.UNIFORM) {
          access += "UNIFORM ";
        }
        if (value & GPUBufferUsage.STORAGE) {
          access += "STORAGE ";
        }
        if (value & GPUBufferUsage.INDIRECT) {
          access += "INDIRECT ";
        }
        if (value & GPUBufferUsage.QUERY_RESOLVE) {
          access += "QUERY_RESOLVE ";
        }
        info[key] = access || "NONE";
      } else if (object instanceof Texture && key == "usage") {
        let access = "";
        if (value & GPUTextureUsage.COPY_SRC) {
          access += "COPY_SRC ";
        }
        if (value & GPUTextureUsage.COPY_DST) {
          access += "COPY_DST ";
        }
        if (value & GPUTextureUsage.TEXTURE_BINDING) {
          access += "TEXTURE_BINDING ";
        }
        if (value & GPUTextureUsage.STORAGE_BINDING) {
          access += "STORAGE_BINDING ";
        }
        if (value & GPUTextureUsage.RENDER_ATTACHMENT) {
          access += "RENDER_ATTACHMENT ";
        }
        info[key] = access || "NONE";
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

  _inspectObject(object) {
    this.inspectPanel.html = "";

    const infoBox = new Div(this.inspectPanel, { style: "background-color: #353; padding: 10px;" });
    new Div(infoBox, { text: `${object.label || object.constructor.name} ID:${object.id}` });

    if (object instanceof Texture) {
      const gpuSize = object.getGpuSize();
      const sizeStr = gpuSize < 0 ? "<unknown>" : gpuSize.toLocaleString("en-US");
      new Div(infoBox, { text: `GPU Size: ${sizeStr} Bytes`, style: "font-size: 10pt; margin-top: 5px;" });
    }

    const dependencies = this.database.getObjectDependencies(object);
    new Div(infoBox, { text: `Used By: ${dependencies.length} Objects`, style: "font-size: 10pt; color: #aaa;"});
    const depGrp = new Div(infoBox, { style: "font-size: 10pt; color: #aaa; padding-left: 20px; max-height: 50px; overflow: auto;" })
    for (const dep of dependencies) {
      new Div(depGrp, { text: `${dep.label || dep.constructor.name} ${dep.id}` });
    }

    const descriptionBox = new Div(this.inspectPanel, { style: "height: calc(-185px + 100vh);" });

    if (object instanceof ShaderModule) {
      const text = object.descriptor.code;
      new Widget("pre", descriptionBox, { text });
    } else {
      const desc = this._getDescriptorInfo(object, object.descriptor);
      const text = JSON.stringify(desc, undefined, 4);
      new Widget("pre", descriptionBox, { text });
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
    const name = `${object.label || object.constructor.name}`;
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
    }
    object.widget = new Widget("li", ui);

    object.nameWidget = new Span(object.widget, { text: name });
    new Span(object.widget, { text: `ID: ${object.id}`, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
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
