import { Button } from "./widget/button.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { TabWidget } from "./widget/tab_widget.js";
import { TextureFormatInfo } from "../utils/texture_format_info.js";
import { Widget } from "./widget/widget.js";
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
import { getFlagString } from "../utils/flags.js";

export class InspectPanel {
  constructor(window, parent) {
    this.window = window;

    const self = this;
    const controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; font-size: 10pt;" });

    this.inspectButton = new Button(controlBar, { label: "Start", callback: () => { 
      try {
        self.database.reset();
        self._reset();
        self.port.postMessage({ action: "initialize_inspector" });
      } catch (e) {}
    } });

    const stats = new Span(controlBar, { style: "border-left: 1px solid #aaa; padding-left: 10px; margin-left: 20px; height: 20px; padding-top: 5px; color: #ddd;" });
    this.uiFrameTime = new Span(stats);
    this.uiTotalTextureMemory = new Span(stats, { style: "margin-left: 20px;" });
    this.uiTotalBufferMemory = new Span(stats, { style: "margin-left: 20px;" });

    this.inspectorGUI = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-85px + 100vh); display: flex;" });

    this.database.onObjectLabelChanged.addListener(this._objectLabelChanged, this);
    this.database.onAddObject.addListener(this._addObject, this);
    this.database.onDeleteObject.addListener(this._deleteObject, this);
    this.database.onEndFrame.addListener(this._updateFrameStats, this);

    window.onTextureLoaded.addListener(this._textureLoaded, this);

    this._reset();
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

  _reset() {
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

  _textureLoaded(texture) {
    if (this._inspectedObject == texture) {
      this._inspectObject(texture);
    }
  }

  _updateFrameStats() {
    this.uiFrameTime.text = `Frame Time: ${this.database.frameTime.toFixed(2)}ms`;
    const totalTextureMemory = this.database.totalTextureMemory.toLocaleString("en-US");
    this.uiTotalTextureMemory.text = `Texture Memory: ${totalTextureMemory} Bytes`;
    const totalBufferMemory = this.database.totalBufferMemory.toLocaleString("en-US");
    this.uiTotalBufferMemory.text = `Buffer Memory: ${totalBufferMemory} Bytes`;
  }

  _objectLabelChanged(id, object, label) {
    if (object && object.widget) {
      object.nameWidget.text = label || object.constructor.name;
    }
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
    } else if (object instanceof TextureView) {
      this.uiTextureViews.count.text = `${this.database.textureViews.size}`;
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
    if (object.stacktrace) {
      new Div(infoBox, { text: "Stacktrace:", style: "font-size: 10pt;color: #fff;padding-left: 10px;margin-top: 10px;line-height: 30px;background-color: rgb(85, 85, 119);" });
      new Div(infoBox, { text: object.stacktrace, style: "font-size: 10pt;color: #ddd;overflow: auto;background-color: rgb(51, 51, 85);box-shadow: #000 0 3px 5px;padding: 5px;padding-left: 10px;" })
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

  _createTexturePreview(texture, parent, width, height) {
    width ??= texture.width;
    height ??= texture.height;
    const canvas = new Widget("canvas", parent);
    canvas.element.width = width;
    canvas.element.height = height;
    const context = canvas.element.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const device = this.window.device;
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
        const usage = getFlagString(value, GPUBufferUsage);
        info[key] = usage || "NONE";
      } else if (object instanceof Texture && key == "usage") {
        let usage = getFlagString(value, GPUTextureUsage);
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
}
