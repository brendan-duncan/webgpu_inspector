import { Button } from "./widget/button.js";
import { Collapsable } from "./widget/collapsable.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { TabWidget } from "./widget/tab_widget.js";
import { TextureFormatInfo } from "../utils/texture_format_info.js";
import { Widget } from "./widget/widget.js";
import { Adapter } from "./gpu_objects/adapter.js";
import { 
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
  ComputePipeline,
  ValidationError } from "./gpu_objects/index.js";
import { getFlagString } from "../utils/flags.js";
import { Plot } from "./widget/plot.js";
import { EditorView } from "codemirror";

import { keymap, highlightSpecialChars, drawSelection, dropCursor,
  crosshairCursor, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching,
  foldGutter, foldKeymap } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { wgsl } from "../thirdparty/codemirror_lang_wgsl.js";
import { cobalt } from 'thememirror';

const shaderEditorSetup = (() => [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  crosshairCursor(),
  cobalt,
  wgsl(),
  keymap.of([
    indentWithTab,
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap
  ])
])();

export class InspectPanel {
  constructor(window, parent) {
    this.window = window;

    const self = this;
    const controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; font-size: 10pt;" });

    this.inspectButton = new Button(controlBar, { label: "Start", callback: () => { 
      try {
        self._reset();
        self.port.postMessage({ action: "initialize_inspector" });
      } catch (e) {}
    } });

    const stats = new Span(controlBar, { style: "border-left: 1px solid #aaa; padding-left: 10px; margin-left: 20px; height: 20px; padding-top: 5px; color: #ddd;" });
    this.uiFrameTime = new Span(stats, { style: "width: 140px; overflow: hidden;" });
    this.uiTotalTextureMemory = new Span(stats, { style: "margin-left: 20px;" });
    this.uiTotalBufferMemory = new Span(stats, { style: "margin-left: 20px;" });

    this.plots = new Div(parent, { style: "display: flex; flex-direction: row; margin-bottom: 10px; height: 30px;" });
    this.frameRatePlot = new Plot(this.plots, { style: "flex-grow: 1; margin-right: 10px;" });
    
    this.frameRateData = this.frameRatePlot.addData("Frame Time");

    this.inspectorGUI = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-85px + 100vh); display: flex;" });

    this.database.onObjectLabelChanged.addListener(this._objectLabelChanged, this);
    this.database.onAddObject.addListener(this._addObject, this);
    this.database.onDeleteObject.addListener(this._deleteObject, this);
    this.database.onEndFrame.addListener(this._updateFrameStats, this);
    this.database.onValidationError.addListener(this._validationError, this);

    window.onTextureLoaded.addListener(this._textureLoaded, this);

    // Recycle DOM elements as objects are created and destroyed.
    // The DevTools panel will crash after a while if there is too much thrashing
    // of DOM elements.
    this._recycledWidgets = {};

    // Periodically clean up old recycled widgets.
    const cleanupInterval = 2000;
    setInterval(() => {
      const time = performance.now();
      for (const type in this._recycledWidgets) {
        const list = this._recycledWidgets[type];
        const length = list.length;
        for (let i = length - 1; i >= 0; --i) {
          const widget = list[i];
          if ((time - widget._destroyTime) > 5000) {
            widget.element.remove();
            list.splice(i, 1);
          }
        }
      }
    }, cleanupInterval);

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
    this.database.reset();
    this.frameRatePlot.reset();

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
    this.uiValidationErrors = this._createObjectListUI(objectsPanel, "Validation Errors");
  }

  _validationError(error) {
    this._addObject(error, false);
    if (error.object === this._inspectedObject?.id) {
      this._inspectObject(this._inspectedObject);
    }
  }

  _textureLoaded(texture) {
    if (this._inspectedObject === texture) {
      this._inspectObject(texture);
    } else if (this._inspectedObject instanceof TextureView) {
      const inspectedTexture = this.database.getTextureFromView(this._inspectedObject);
      if (inspectedTexture === texture) {
        this._inspectObject(this._inspectedObject);
      }
    }
  }

  _updateFrameStats() {
    this.uiFrameTime.text = `Frame Time: ${this.database.frameTime.toFixed(2)}ms`;
    const totalTextureMemory = this.database.totalTextureMemory.toLocaleString("en-US");
    this.uiTotalTextureMemory.text = `Texture Memory: ${totalTextureMemory} Bytes`;
    const totalBufferMemory = this.database.totalBufferMemory.toLocaleString("en-US");
    this.uiTotalBufferMemory.text = `Buffer Memory: ${totalBufferMemory} Bytes`;

    this.frameRateData.add(this.database.frameTime);
    this.frameRatePlot.draw();
  }

  _objectLabelChanged(id, object, label) {
    if (object?.widget?.nameWidget) {
      object.widget.nameWidget.text = label || object.constructor.className;
    }
  }

  _getRecycledWidget(object) {
    const objectType = object.constructor.className;
    if (this._recycledWidgets[objectType]) {
      return this._recycledWidgets[objectType].pop();
    }
    return null;
  }

  _recycleWidget(object, widget) {
    const objectType = object.constructor.className;
    if (!this._recycledWidgets[objectType]) {
      this._recycledWidgets[objectType] = [];
    }
    this._recycledWidgets[objectType].push(widget);
  }

  _deleteObject(id, object) {
    // Instead of deleting the objects widget from the DOM, recycle
    // it so the next time an object of this type is created, it will
    // use the recycled widget instead of creating a new one.
    const widget = object?.widget;
    if (widget) {
      this._recycleWidget(object, widget);
      widget.element.style.display = "none";
      widget._destroyTime = performance.now();
      object.widget = null;
    }
    this._updateObjectStat(object);
  }

  _updateObjectStat(object) {
    if (object instanceof Adapter) {
      this.uiAdapters.label.text = `Adapters ${this.database.adapters.size}`;
    } else if (object instanceof Device) {
      this.uiDevices.label.text = `Devices ${this.database.devices.size}`;
    } else if (object instanceof Buffer) {
      this.uiBuffers.label.text = `Buffers ${this.database.buffers.size}`;
    } else if (object instanceof Sampler) {
      this.uiSamplers.label.text = `Samplers ${this.database.samplers.size}`;
    } else if (object instanceof Texture) {
      this.uiTextures.label.text = `Textures ${this.database.textures.size}`;
    } else if (object instanceof TextureView) {
      this.uiTextureViews.label.text = `TextureViews ${this.database.textureViews.size}`;
    } else if (object instanceof ShaderModule) {
      this.uiShaderModules.label.text = `ShaderModules ${this.database.shaderModules.size}`;
    } else if (object instanceof BindGroupLayout) {
      this.uiBindGroupLayouts.label.text = `BindGroupLayouts ${this.database.bindGroupLayouts.size}`;
    } else if (object instanceof PipelineLayout) {
      this.uiPipelineLayouts.label.text = `PipelineLayouts ${this.database.pipelineLayouts.size}`;
    } else if (object instanceof BindGroup) {
      this.uiBindGroups.label.text = `BindGroups ${this.database.bindGroups.size}`;
    } else if (object instanceof RenderPipeline) {
      this.uiPendingAsyncRenderPipelines.label.text = `Pending Async Render Pipelines ${this.database.pendingRenderPipelines.size}`;
      this.uiRenderPipelines.label.text = `Render Pipelines ${this.database.renderPipelines.size}`;
    } else if (object instanceof ComputePipeline) {
      this.uiPendingAsyncComputePipelines.label.text = `Pending Async Compute Pipelines ${this.database.pendingComputePipelines.size}`;
      this.uiComputePipelines.label.text = `Compute Pipelines ${this.database.computePipelines.size}`;
    } else if (object instanceof ValidationError) {
      this.uiValidationErrors.label.text = `Validation Errors ${this.database.validationErrors.size}`;
    }
  }

  _addObject(object, pending) {
    this._updateObjectStat(object);
    if (object instanceof Adapter) {
      this._addObjectToUI(object, this.uiAdapters);
    } else if (object instanceof Device) {
      this._addObjectToUI(object, this.uiDevices);
    } else if (object instanceof Buffer) {
      this._addObjectToUI(object, this.uiBuffers);
    } else if (object instanceof Sampler) {
      this._addObjectToUI(object, this.uiSamplers);
    } else if (object instanceof Texture) {
      this._addObjectToUI(object, this.uiTextures);
    } else if (object instanceof TextureView) {
      this._addObjectToUI(object, this.uiTextureViews);
    } else if (object instanceof ShaderModule) {
      this._addObjectToUI(object, this.uiShaderModules);
    } else if (object instanceof BindGroupLayout) {
      this._addObjectToUI(object, this.uiBindGroupLayouts);
    } else if (object instanceof PipelineLayout) {
      this._addObjectToUI(object, this.uiPipelineLayouts);
    } else if (object instanceof BindGroup) {
      this._addObjectToUI(object, this.uiBindGroups);
    } else if (object instanceof RenderPipeline) {
      this._addObjectToUI(object, pending ? this.uiPendingAsyncRenderPipelines : this.uiRenderPipelines);
    } else if (object instanceof ComputePipeline) {
      this._addObjectToUI(object, pending ? this.uiPendingAsyncComputePipelines : this.uiComputePipelines);
    } else if (object instanceof ValidationError) {
      this._addObjectToUI(object, this.uiValidationErrors);
    }
  }

  _createObjectListUI(parent, name) {
    const panel = new Collapsable(parent, { collapsed: true, label: `${name} 0` });

    const self = this;
    panel.onExpanded.addListener(() => {
      if (self._selectedGroup && self._selectedGroup != panel) {
        self._selectedGroup.collapsed = true;
      }
      self._selectedGroup = panel;
    });

    const objectList = new Widget("ol", panel.body, { style: "margin-top: 10px; margin-bottom: 10px;"});
    panel.objectList = objectList;

    return panel;
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
    } else if (object instanceof Buffer) {
      const access = object.descriptor.usage;

      if (access & GPUBufferUsage.INDEX) {
        type += " INDEX";
      }
      if (access & GPUBufferUsage.VERTEX) {
        type += " VERTEX";
      }
      if (access & GPUBufferUsage.STORAGE) {
        type += " STORAGE";
      }
      if (access & GPUBufferUsage.INDIRECT) {
        type += " INDIRECT";
      }
      if (access & GPUBufferUsage.QUERY_RESOLVE) {
        type += " QUERY_RESOLVE";
      }

      type += ` ${object.descriptor.size.toLocaleString("en-US")} Bytes`;
    }

    const idName = object.id < 0 ? "CANVAS" : object.id;

    let widget = this._getRecycledWidget(object);
    if (widget) {
      widget.element.style.display = undefined;
      widget.nameWidget.text = name;
      widget.idWidget.text = `ID: ${idName}`;
      if (type) {
        widget.typeWidget.text = type;
      }
    } else {
      widget = new Widget("li", ui.objectList);

      widget.nameWidget = new Span(widget, { text: name });
      
      widget.idWidget = new Span(widget, { text: `ID: ${idName}`, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
      if (type) {
        widget.typeWidget = new Span(widget, { text: type, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
      }
    }

    object.widget = widget;
    widget.group = ui;

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
      const stacktraceGrp = new Collapsable(infoBox, { collapsed: true, label: "Stacktrace", collapsed: true });
      new Div(stacktraceGrp.body, { text: object.stacktrace, style: "font-size: 10pt;color: #ddd;overflow: auto;background-color: rgb(51, 51, 85);box-shadow: #000 0 3px 5px;padding: 5px;padding-left: 10px;" })
    }

    const errorLines = [];

    const errors = this.database.findObjectErrors(object.id);
    if (errors.length > 0) {
      const errorsGrp = new Collapsable(infoBox, { collapsed: true, label: "Errors", collapsed: true });
      for (const error of errors) {
        new Div(errorsGrp.body, { text: error.message, class: "inspect_info_error" });

        const errorRegEx = /.+ :([0-9]+):([0-9]+) error: (.+)/.exec(error.message);
        if (errorRegEx.length == 4) {
          const line = errorRegEx[1];
          const message = errorRegEx[3];
          errorLines.push({ line, message });
        }
      }
    }

    let compileButton = null;
    let revertButton = null;
    if (object instanceof ShaderModule) {
      const isModified = object.replacementCode && object.replacementCode !== object.descriptor.code;

      const compileRow = new Div(this.inspectPanel);
      compileButton = new Button(compileRow, { label: "Compile", style: "background-color: rgb(200, 150, 51);" });
      revertButton = isModified ? new Button(compileRow, { label: "Revert", style: "background-color: rgb(200, 150, 51);" }) : null;
    }

    const descriptionBox = new Div(this.inspectPanel, { style: "height: calc(-270px + 100vh); overflow: auto;" });

    if (object instanceof ShaderModule) {
      const self = this;
     
      const text = object.replacementCode || object.descriptor.code;

      const editor = new EditorView({
        doc: text,
        extensions: [
          shaderEditorSetup
        ],
        parent: descriptionBox.element,
      });

      compileButton.callback = () => {
        const code = editor.state.doc.toString();
        self._compileShader(object, code);
        object.replacementCode = code;
        self._inspectObject(object); // refresh the inspection info panel
      };

      if (revertButton) {
        revertButton.callback = () => {
          const code = object.descriptor.code;
          self._compileShader(object, code);
          object.replacementCode = null;
          self._inspectObject(object); // refresh the inspection info panel
        };
      }
    } else if (object instanceof ValidationError) {
      const objectId = object.object;
      if (objectId) {
        const obj = this.database.getObject(objectId);
        if (obj) {
          const self = this;
          new Button(infoBox, { label: `${obj.name}.${obj.id}`, style: "background-color: #733; color: #fff;" , callback: () => {
            if (obj.widget) {
              if (obj.widget.group) {
                obj.widget.group.collapsed = false;
              }
              obj.widget.element.click();
            } else {
              self._inspectObject(obj);
            }
          } });
        }
      }
      const text = object.message;
      new Widget("pre", descriptionBox, { text });
    } else {
      const desc = this._getDescriptorInfo(object, object.descriptor);
      const text = JSON.stringify(desc, undefined, 4);
      new Widget("pre", descriptionBox, { text });
    }

    if (object instanceof Texture) {
      const self = this;
      const loadButton = new Button(descriptionBox, { label: "Load", callback: () => {
        self.database.requestTextureData(object);
      }});
      if (TextureFormatInfo[object.descriptor.format]?.isDepthStencil) {
        loadButton.disabled = true;
        loadButton.tooltip = "Previewing depth-stencil textures is currently disabled.";
      }
      if (object.gpuTexture) {
        this._createTexturePreview(object, descriptionBox);
      }
    } else if (object instanceof TextureView) {
      const texture = this.database.getTextureFromView(object);
      if (texture) {
        const textureGrp = new Collapsable(descriptionBox, { label: `Texture ${texture.dimension} ${texture.format} ${texture.width}x${texture.height}` });
        textureGrp.body.style.maxHeight = "unset";

        const desc = this._getDescriptorInfo(texture, texture.descriptor);
        const text = JSON.stringify(desc, undefined, 4);
        new Widget("pre", textureGrp.body, { text });

        const self = this;
        
        const loadButton = new Button(textureGrp.body, { label: "Load", callback: () => {
          self.database.requestTextureData(texture);
        }});
        if (TextureFormatInfo[texture.descriptor.format]?.isDepthStencil) {
          loadButton.disabled = true;
          loadButton.tooltip = "Previewing depth-stencil textures is currently disabled.";
        }
        if (texture.gpuTexture) {
          this._createTexturePreview(texture, textureGrp.body);
        }
      }
    }
  }

  _compileShader(object, code) {
    if (code === object.code) {
      return;
    }
    this.database.removeErrorsForObject(object.id);
    this.port.postMessage({ action: "inspect_compile_shader", id: object.id, code });
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
        return `${obj.constructor.className} ${descriptor["__id"]}`;
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
            info[key] = `${obj.constructor.className} ${value["__id"]}`;
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
