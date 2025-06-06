import { Button } from "./widget/button.js";
import { Collapsable } from "./widget/collapsable.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { TabWidget } from "./widget/tab_widget.js";
import { Widget } from "./widget/widget.js";
import { NumberInput } from "./widget/number_input.js";
import { Select } from "./widget/select.js";
import { Signal } from "../utils/signal.js";
import {
  Adapter,
  Device,
  Buffer,
  Sampler,
  Texture,
  TextureView,
  ShaderModule,
  BindGroupLayout,
  PipelineLayout,
  BindGroup,
  RenderBundle,
  RenderPipeline,
  ComputePipeline,
  ValidationError } from "./gpu_objects/index.js";
import { getFlagString } from "../utils/flags.js";
import { PanelActions } from "../utils/actions.js";
import { Plot } from "./widget/plot.js";
import { Split } from "./widget/split.js";

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
  constructor(win, parent) {
    this.window = win;

    const self = this;
    const _controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; font-size: 10pt; display: flex;" });
    const controlBar = new Div(_controlBar);

    this.inspectButton = new Button(controlBar, { label: "Start", style: "background-color: #575;", callback: () => {
      try {
        self._reset();
        self.port.postMessage({ action: PanelActions.InitializeInspector });
      } catch (e) {}
    } });

    const stats = new Span(controlBar, { style: "border-left: 1px solid #aaa; padding-left: 10px; margin-left: 20px; height: 20px; padding-top: 5px; color: #ddd;" });
    this.uiFrameTime = new Span(stats, { style: "width: 140px; overflow: hidden;" });
    this.uiTotalTextureMemory = new Span(stats, { style: "margin-left: 20px;" });
    this.uiTotalBufferMemory = new Span(stats, { style: "margin-left: 20px;" });

    new Span(_controlBar, { style: "flex-grow: 2;" });

    new Button(_controlBar, { label: "Help", style: "margin-left: 20px; background-color: #557;", callback: () => {
      window.open("https://github.com/brendan-duncan/webgpu_inspector/blob/main/docs/inspect.md", "_blank");
    }});

    this.plots = new Div(parent, { style: "display: flex; flex-direction: row; margin-bottom: 10px; height: 30px;" });
    new Span(this.plots, { text: "Frame Time", style: "color: #ccc; padding-top: 5px; margin-right: 10px; font-size: 10pt;"});
    this.frameRatePlot = new Plot(this.plots, { precision: 2, suffix: "ms", style: "flex-grow: 1; margin-right: 10px; max-width: 500px; box-shadow: 3px 3px 5px rgba(0, 0, 0, 0.5);" });
    this.frameRateData = this.frameRatePlot.addData("Frame Time");

    this._objectCountType = null;
    this._objectCountObject = null;

    new Select(this.plots, {
      options: ["GPU Objects", "Buffer", "BindGroup", "TextureView", "Texture", "Sampler", "PipelineLayout", "BindGroupLayout", "ShaderModule", "ComputePipeline", "RenderPipeline", "RenderBundle"],
      index: 0,
      style: "color: #ccc; padding-top: 5px; margin-right: 10px; font-size: 10pt;",
      onChange: (value) => {
        self._changeObjectCountPlot(value);
      } });
    this.objectCountPlot = new Plot(this.plots, { style: "flex-grow: 1; max-width: 500px; box-shadow: 3px 3px 5px rgba(0, 0, 0, 0.5);" });
    this.objectCountData = this.objectCountPlot.addData("Object Count");
    this._changeObjectCountPlot(0);

    this.inspectorGUI = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-85px + 100vh); display: flex;" });

    this.database.onObjectLabelChanged.addListener(this._objectLabelChanged, this);
    this.database.onAddObject.addListener(this._addObject, this);
    this.database.onDeleteObject.addListener(this._deleteObject, this);
    this.database.onDeltaFrameTime.addListener(this._updateFrameStats, this);
    this.database.onValidationError.addListener(this._validationError, this);
    this.database.onResolvePendingObject.addListener(this._resolvePendingObject, this);

    this.window.onTextureLoaded.addListener(this._textureLoaded, this);

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

  get inspectedObject() {
    return this.database.inspectedObject;
  }

  inspectObject(object) {
    if (!object) {
      return;
    }
    if (object.widget) {
      object.widget.group.expand();
      object.widget.element.click();
    }
  }

  _changeObjectCountPlot(value) {
    if (value === this._objectCountType) {
      return;
    }
    this._objectCountType = value;
    switch (value) {
      case "GPU Objects":
        this._objectCountObject = this.database.allObjects;
        break;
      case "Buffer":
        this._objectCountObject = this.database.buffers;
        break;
      case "BindGroup":
        this._objectCountObject = this.database.bindGroups;
        break;
      case "TextureView":
        this._objectCountObject = this.database.textureViews;
        break;
      case "Texture":
        this._objectCountObject = this.database.textures;
        break;
      case "Sampler":
        this._objectCountObject = this.database.samplers;
        break;
      case "PipelineLayout":
        this._objectCountObject = this.database.pipelineLayouts;
        break;
      case "BindGroupLayout":
        this._objectCountObject = this.database.bindGroupLayouts;
        break;
      case "ShaderModule":
        this._objectCountObject = this.database.shaderModules;
        break;
      case "ComputePipeline":
        this._objectCountObject = this.database.computePipelines;
        break;
      case "RenderPipeline":
        this._objectCountObject = this.database.renderPipelines;
        break;
      case "RenderBundle":
        this._objectCountObject = this.database.renderBundles;
        break;
    }
    this.objectCountPlot.reset();
  }

  _reset() {
    this.database.reset();
    this.frameRatePlot.reset();
    this.objectCountPlot.reset();

    // Recycle DOM elements as objects are created and destroyed.
    // The DevTools panel will crash after a while if there is too much thrashing
    // of DOM elements.
    this._recycledWidgets = {};
    this._inspectedInfoBox = null;

    this._selectedObject = null;
    this._selectedGroup = null;
    this.inspectorGUI.html = "";

    const split = new Split(this.inspectorGUI, { direction: Split.Horizontal, position: 340 });

    const pane1 = new Span(split);

    const objectsTab = new TabWidget(pane1);
    const objectsPanel = new Div(null, { style: "font-size: 11pt; overflow: auto; height: calc(-115px + 100vh);" });
    objectsTab.addTab("Objects", objectsPanel);

    const pane2 = new Span(split, { style: "flex-grow: 1; overflow: hidden;" });

    const inspectTab = new TabWidget(pane2);
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
    this.uiBindGroupLayouts = this._createObjectListUI(objectsPanel, "Bind Group Layouts");
    this.uiPipelineLayouts = this._createObjectListUI(objectsPanel, "Pipeline Layouts");
    this.uiRenderBundles = this._createObjectListUI(objectsPanel, "Render Bundles");
    this.uiPendingAsyncRenderPipelines = this._createObjectListUI(objectsPanel, "Pending Async Render Pipelines");
    this.uiPendingAsyncComputePipelines = this._createObjectListUI(objectsPanel, "Pending Async Compute Pipelines");
    this.uiValidationErrors = this._createObjectListUI(objectsPanel, "Validation Errors");
  }

  _validationError(error) {
    this._addObject(error, false);
    if (error.object === this.inspectedObject?.id) {
      this._inspectObject(this.inspectedObject);
    }
    const object = this.database.getObject(error.object);
    if (object?.widget) {
      object.widget.element.classList.add("error");
      object.widget.tooltip = error.message;
      for (const child of object.widget.children) {
        child.tooltip = error.message;
      }
    }
  }

  _textureLoaded(texture) {
    if (this.inspectedObject === texture) {
      this._inspectObject(texture);
    } else if (this.inspectedObject instanceof TextureView) {
      const inspectedTexture = this.database.getTextureFromView(this.inspectedObject);
      if (inspectedTexture === texture) {
        this._inspectObject(this.inspectedObject);
      }
    }
  }

  _updateFrameStats() {
    this.uiFrameTime.text = `Frame Time: ${this.database.deltaFrameTime.toFixed(2)}ms`;
    const totalTextureMemory = this.database.totalTextureMemory.toLocaleString("en-US");
    this.uiTotalTextureMemory.text = `Texture Memory: ${totalTextureMemory} Bytes`;
    const totalBufferMemory = this.database.totalBufferMemory.toLocaleString("en-US");
    this.uiTotalBufferMemory.text = `Buffer Memory: ${totalBufferMemory} Bytes`;

    this.frameRateData.add(this.database.deltaFrameTime);
    this.frameRatePlot.draw();

    this.objectCountData.add(this._objectCountObject?.size ?? this.database.allObjects.size);
    this.objectCountPlot.draw();
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

  _resolvePendingObject(id, object) {
    const widget = object?.widget;
    if (widget) {
      widget.element.remove();
      object.widget = null;

      this._addObject(object, false);
    }
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

    if (object === this.inspectedObject) {
      if (this._inspectedInfoBox) {
        this._inspectedInfoBox.style.backgroundColor = "#533";
      }
    }
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
      this.uiTextureViews.label.text = `Texture Views ${this.database.textureViews.size}`;
    } else if (object instanceof ShaderModule) {
      this.uiShaderModules.label.text = `Shader Modules ${this.database.shaderModules.size}`;
    } else if (object instanceof BindGroupLayout) {
      this.uiBindGroupLayouts.label.text = `Bind Group Layouts ${this.database.bindGroupLayouts.size}`;
    } else if (object instanceof PipelineLayout) {
      this.uiPipelineLayouts.label.text = `Pipeline Layouts ${this.database.pipelineLayouts.size}`;
    } else if (object instanceof BindGroup) {
      this.uiBindGroups.label.text = `Bind Groups ${this.database.bindGroups.size}`;
    } else if (object instanceof RenderPipeline) {
      this.uiPendingAsyncRenderPipelines.label.text = `Pending Async Render Pipelines ${this.database.pendingRenderPipelines.size}`;
      this.uiRenderPipelines.label.text = `Render Pipelines ${this.database.renderPipelines.size}`;
    } else if (object instanceof ComputePipeline) {
      this.uiPendingAsyncComputePipelines.label.text = `Pending Async Compute Pipelines ${this.database.pendingComputePipelines.size}`;
      this.uiComputePipelines.label.text = `Compute Pipelines ${this.database.computePipelines.size}`;
    } else if (object instanceof ValidationError) {
      this.uiValidationErrors.label.text = `Validation Errors ${this.database.validationErrors.size}`;
    } else if (object instanceof RenderBundle) {
      this.uiRenderBundles.label.text = `Render Bundles ${this.database.renderBundles.size}`;
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
    } else if (object instanceof RenderBundle) {
      this._addObjectToUI(object, this.uiRenderBundles);
    }
  }

  _createObjectListUI(parent, name) {
    const panel = new Collapsable(parent, { collapsed: true, label: `${name} 0` });
    panel.body.style.maxHeight = "300px";
    panel.body.style.overflow = "auto";

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
      type += ` ${object.descriptor.format} ${object.resolutionString}`;
    } else if (object instanceof TextureView) {
      const texture = this.database.getTextureFromView(object);
      if (texture) {
        type += ` Texture:${texture.idName} ${texture.descriptor.format} ${texture.resolutionString}`;
      }
    } else if (object instanceof Buffer) {
      const access = object.descriptor.usage;

      if (access & GPUBufferUsage.INDEX) {
        type += " INDEX";
      }
      if (access & GPUBufferUsage.VERTEX) {
        type += " VERTEX";
      }
      if (access & GPUBufferUsage.UNIFORM) {
        type += " UNIFORM";
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
    }

    const idName = object.idName;

    let widget = this._getRecycledWidget(object);
    if (widget) {
      const parent = ui.objectList;
      parent.removeChild(widget);
      parent.appendChild(widget);
      widget.element.style.display = "list-item";
      widget.nameWidget.text = name;
      widget.idWidget.text = `ID:${idName}`;
      widget.typeWidget.text = type;
    } else {
      widget = new Widget("li", ui.objectList);
      widget.nameWidget = new Span(widget, { text: name });
      widget.idWidget = new Span(widget, { text: `ID:${idName}`, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
      widget.typeWidget = new Span(widget, { text: type, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
    }

    object.widget = widget;
    widget.group = ui;

    const self = this;
    object.widget.element.onclick = () => {
      if (self._selectedObject && self._selectedObject.widget) {
        self._selectedObject.widget.element.classList.remove("selected");
      }
      object.widget.element.classList.add("selected");
      self._selectedObject = object;
      self._inspectObject(object);
    };
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

  _inspectObject(object) {
    this.inspectPanel.html = "";

    this.database.inspectedObject = object;

    const infoStyle = object.isDeleted ? "background-color: #533;" : "background-color: #353;";

    const infoBox = new Div(this.inspectPanel, { style: `${infoStyle} padding: 10px;` });
    const idName = object.idName;
    new Div(infoBox, { text: `${object.name} ID: ${idName} ${object.isDeleted ? "<deleted>" : ""}` });
    this._inspectedInfoBox = infoBox;

    if (object instanceof Texture) {
      const gpuSize = object.getGpuSize();
      const sizeStr = gpuSize < 0 ? "<unknown>" : gpuSize.toLocaleString("en-US");
      new Div(infoBox, { text: `GPU Size: ${sizeStr} Bytes`, style: "font-size: 10pt; margin-top: 5px;" });
    }

    const dependencies = this.database.getObjectDependencies(object);
    new Div(infoBox, { text: `Reference Count: ${object.referenceCount}`, style: "font-size: 10pt; color: #aaa;"});

    if (object instanceof RenderBundle) {
      new Div(infoBox, { text: `Bundle Commands: ${object.commands.length}`, style: "font-size: 10pt; color: #aaa;"});
    }

    const depGrp = new Div(infoBox, { style: "font-size: 10pt; color: #aaa; padding-left: 20px; max-height: 50px; overflow: auto;" })
    for (const dep of dependencies) {
      new Div(depGrp, { text: `${dep.name} ${dep.idName}` });
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
        if (errorRegEx?.length == 4) {
          const line = errorRegEx[1];
          const message = errorRegEx[3];
          errorLines.push({ line, message });
        }
      }
    }

    function createDependencyLink(obj, label, parent) {
      const link = new Widget("li", parent, { text: label, class: "dependency_link" });
      link.element.onclick = () => {
        obj.widget.group.expand();
        obj.widget.element.click();
      };
    }

    let compileButton = null;
    let revertButton = null;
    if (object instanceof RenderPipeline || object instanceof ComputePipeline) {
      const grp = new Collapsable(infoBox, { label: "Dependencies", collapsed: true });
      const ul = new Widget("ul", grp.body);
      const descriptor = object.descriptor;
      if (descriptor.layout) {
        const obj = this.database.getObject(descriptor.layout.__id);
        if (obj) {
          createDependencyLink(obj, `Layout: ${obj.name}(${obj.idName})`, ul);
        }
      }
      if (descriptor.vertex) {
        const obj = this.database.getObject(descriptor.vertex.module.__id);
        if (obj) {
          createDependencyLink(obj, `Vertex Module: ${obj.name}(${obj.idName})`, ul);
        }
      }
      if (descriptor.fragment) {
        const obj = this.database.getObject(descriptor.fragment.module.__id);
        if (obj) {
          createDependencyLink(obj, `Fragment Module: ${obj.name}(${obj.idName})`, ul);
        }
      }
    }

    if (object instanceof PipelineLayout) {
      const grp = new Collapsable(infoBox, { label: "Dependencies", collapsed: true });
      const ul = new Widget("ul", grp.body);
      const descriptor = object.descriptor;
      const bindGroupLayouts = descriptor.bindGroupLayouts;
      for (let i = 0; i < bindGroupLayouts.length; ++i) {
        const obj = this.database.getObject(bindGroupLayouts[i].__id);
        if (obj) {
          createDependencyLink(obj, `Bind Group Layout ${i}: ${obj.name}(${obj.idName})`, ul);
        }
      }
    }

    if (object instanceof BindGroup) {
      const grp = new Collapsable(infoBox, { label: "Dependencies", collapsed: true });
      const ul = new Widget("ul", grp.body);
      const descriptor = object.descriptor;
      const layout = this.database.getObject(descriptor.layout?.__id);
      if (layout) {
        createDependencyLink(layout, `Layout: ${layout.name}(${layout.idName})`, ul);
      }

      if (descriptor.entries) {
        for (let i = 0; i < descriptor.entries.length; ++i) {
          const entry = descriptor.entries[i];
          if (entry.resource.buffer?.__id) {
            const obj = this.database.getObject(entry.resource.buffer.__id);
            createDependencyLink(obj, `Buffer ${entry.binding}: ${obj.name}(${obj.idName})`, ul);
          } else if (entry.resource.__id) {
            const obj = this.database.getObject(entry.resource.__id);
            if (obj instanceof Sampler) {
              createDependencyLink(obj, `Sampler ${entry.binding}: ${obj.name}(${obj.idName})`, ul);
            } else {
              createDependencyLink(obj, `Texture View ${entry.binding}: ${obj.name}(${obj.idName})`, ul);
            }
          }
        }
      }
    }

    if (object instanceof ShaderModule) {
      const reflect = object.reflection;
      if (reflect) {
        const grp = new Collapsable(infoBox, { label: "Reflection Info", collapsed: true });
        grp.body.style.maxHeight = "600px";

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

      const isModified = object.replacementCode && object.replacementCode !== object.descriptor.code;
      const compileRow = new Div(this.inspectPanel);
      compileButton = new Button(compileRow, { label: "Compile", style: "background-color: rgb(200, 150, 51);" });
      revertButton = isModified ? new Button(compileRow, { label: "Revert", style: "background-color: rgb(200, 150, 51);" }) : null;
    }

    const descriptionBox = new Div(this.inspectPanel, { style: "height: calc(-320px + 100vh); overflow: auto;" });

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
        if (code === object.descriptor.code) {
          self._revertShader(object);
          object.replacementCode = null;
          self._inspectObject(object); // refresh the inspection info panel
        } else {
          self._compileShader(object, code);
          object.replacementCode = code;
          self._inspectObject(object); // refresh the inspection info panel
        }
      };

      if (revertButton) {
        revertButton.callback = () => {
          self._revertShader(object);
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
          new Button(infoBox, { label: `${obj.name}.${obj.idName}`, style: "background-color: #733; color: #fff;" , callback: () => {
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
      const grp = new Collapsable(descriptionBox, { label: "Descriptor", collapsed: false });
      const desc = this._getDescriptorInfo(object, object.descriptor);
      const text = JSON.stringify(desc, undefined, 4);
      new Widget("pre", grp.body, { text });
    }

    if (object instanceof RenderBundle) {

    } else if (object instanceof Texture) {
      const self = this;
      const loadButton = new Button(descriptionBox, { label: "Load", callback: () => {
        self.database.requestTextureData(object, object.display?.mipLevel ?? 0);
      }});
      if (object.gpuTexture) {
        this._createTexturePreview(object, descriptionBox);
      } else if (!loadButton.disabled) {
        // Auto-load the texture if it's not a depth-stencil texture
        this.database.requestTextureData(object, object.display?.mipLevel ?? 0);
      }
    } else if (object instanceof TextureView) {
      const texture = this.database.getTextureFromView(object);
      if (texture) {
        const textureGrp = new Collapsable(descriptionBox, { label: `Texture ${texture.idName} ${texture.dimension} ${texture.format} ${texture.resolutionString}` });
        textureGrp.body.style.maxHeight = "unset";

        const desc = this._getDescriptorInfo(texture, texture.descriptor);
        const text = JSON.stringify(desc, undefined, 4);
        new Widget("pre", textureGrp.body, { text });

        const self = this;

        const loadButton = new Button(textureGrp.body, { label: "Load", callback: () => {
          self.database.requestTextureData(texture);
        }});

        if (texture.gpuTexture) {
          this._createTexturePreview(texture, textureGrp.body);
        } else if (!loadButton.disabled) {
          // Auto-load the texture if it's not a depth-stencil texture
          this.database.requestTextureData(texture);
        }
      }
    }
  }

  _revertShader(object) {
    this.port.postMessage({ action: PanelActions.RevertShader, id: object.id });
  }

  _compileShader(object, code) {
    if (code === object.code) {
      return;
    }
    if (object.widget) {
      object.widget.element.classList.remove("error");
      object.widget.tooltip = "";
      for (const child of object.widget.children) {
        child.tooltip = "";
      }
    }
    this.database.removeErrorsForObject(object.id);
    this.port.postMessage({ action: PanelActions.CompileShader, id: object.id, code });
  }

  _createTexturePreview(texture, parent, width, height) {
    const mipLevel = Math.max(Math.min(texture.display.mipLevel || 0, texture.mipLevelCount), 0);

    width ??= (texture.width >> mipLevel) || texture.width;
    height ??= (texture.height >> mipLevel) || texture.height;

    const numLayers = texture.depthOrArrayLayers;
    const layerRanges = texture.layerRanges;

    const container = new Div(parent, { style: "margin-bottom: 5px; margin-top: 10px;" });

    const displayChanged = new Signal();

    const controls = new Div(container);

    const mipLevels = Array.from({length: texture.mipLevelCount}, (_,i)=>i.toString());

    const self = this;

    new Span(controls, { text:  "Mip Level", style: "margin-right: 3px; font-size: 9pt; color: #bbb;" });
    new Select(controls, {
      options: mipLevels,
      index: texture.display.mipLevel,
      style: "color: #fff; margin-left: 10px; font-size: 10pt; width: 100px;",
      onChange: (value) => {
        const index = mipLevels.indexOf(value);
        texture.display.mipLevel = index || 0;
        if (self._tooltip) {
          self._tooltip.style.display = 'none';
          document.body.removeChild(self._tooltip);
          self._tooltip = null;
        }
        if (texture.isMipLevelLoaded(texture.display.mipLevel)) {
          displayChanged.emit();
        } else {
          self.database.requestTextureData(texture, texture.display.mipLevel || 0);
        }
      } });

    new Span(controls, { text:  "Exposure", style: "margin-right: 3px; font-size: 9pt; color: #bbb;" });
    new NumberInput(controls, { value: texture.display.exposure, step: 0.01, onChange: (value) => {
      texture.display.exposure = value;
      displayChanged.emit();
    }, style: "width: 100px; display: inline-block;" });

    const channels = ["RGB", "Red", "Green", "Blue", "Alpha", "Luminance"];
    new Select(controls, {
      options: channels,
      index: 0,
      style: "color: #fff; margin-left: 10px; font-size: 10pt; width: 100px;",
      onChange: (value) => {
        const index = channels.indexOf(value);
        texture.display.channels = index;
        displayChanged.emit();
      } });

    if (!this._tooltip) {
      this._tooltip = document.createElement('pre');
      document.body.appendChild(this._tooltip);
      this._tooltip.classList.add('inspector-tooltip');
      this._tooltip.style.display = 'none';
    }

    function getPixelString(pixel) {
      if (!pixel) {
        return "<unknown pixel value>";
      }
      let str = "";
      if (pixel.r !== undefined) {
        str += `R: ${pixel.r}\n`;
      }
      if (pixel.g !== undefined) {
        str += `G: ${pixel.g}\n`;
      }
      if (pixel.b !== undefined) {
        str += `B: ${pixel.b}\n`;
      }
      if (pixel.a !== undefined) {
        str += `A: ${pixel.a}\n`;
      }
      return str;
    }

    const hl = 0.5 / numLayers;

    for (let layer = 0; layer < numLayers; ++layer) {
      const layerInfo = new Div(container);
      if (layerRanges) {
        new Span(layerInfo, { text: `Layer ${layer} Min Value: ${layerRanges[layer].min} Max Value: ${layerRanges[layer].max}`, class: 'inspect_texture_layer_info' });
      } else {
        new Span(layerInfo, { text: `Layer ${layer}`, class: 'inspect_texture_layer_info' });
      }
      const canvas = new Widget("canvas", new Div(container), { style: "box-shadow: 5px 5px 5px rgba(0,0,0,0.5);" });
      canvas.element.addEventListener("mouseenter", (event) => {
        if (this._tooltip) {
          this._tooltip.style.display = 'block';
        }
      });
      canvas.element.addEventListener("mouseleave", (event) => {
        if (this._tooltip) {
          this._tooltip.style.display = 'none';
        }
      });
      canvas.element.addEventListener("mousemove", (event) => {
        if (this._tooltip) {
          const x = event.offsetX;
          const y = event.offsetY;
          const pixel = texture.getPixel(x, y, layer, texture.display?.mipLevel ?? 0);
          this._tooltip.style.left = `${event.pageX + 10}px`;
          this._tooltip.style.top = `${event.pageY + 10}px`;
          const pixelStr = getPixelString(pixel);
          this._tooltip.innerHTML = `X:${x} Y:${y}\n${pixelStr}`;
        }
      });

      canvas.element.width = width;
      canvas.element.height = height;
      const context = canvas.element.getContext("webgpu");
      const format = navigator.gpu.getPreferredCanvasFormat();
      const device = this.window.device;
      context.configure({ device, format });
      const canvasTexture = context.getCurrentTexture();

      const viewDesc = {
        aspect: "all",
        dimension: texture.descriptor.dimension ?? "2d",
        baseArrayLayer: texture.descriptor.dimension == "3d" ? 0 : layer,
        layerArrayCount: 1,
        baseMipLevel: mipLevel,
        mipLevelCount: 1 };

      const srcView = texture.gpuTexture.object.createView(viewDesc);

      if (layerRanges) {
        texture.display.minRange = layerRanges[layer].min;
        texture.display.maxRange = layerRanges[layer].max;
      }

      this.textureUtils.blitTexture(srcView, texture.format, 1, canvasTexture.createView(), format, texture.display, texture.descriptor.dimension, (layer / numLayers) + hl);

      const self = this;
      displayChanged.addListener(() => {
        const mipLevel = texture.display.mipLevel;
        const width = (texture.width >> mipLevel) || texture.width;
        const height = (texture.height >> mipLevel) || texture.height;

        canvas.element.width = width;
        canvas.element.height = height;

        const canvasTexture = context.getCurrentTexture();
        const viewDesc = {
          aspect: "all",
          dimension: texture.descriptor.dimension,
          baseArrayLayer: texture.descriptor.dimension == "3d" ? 0 : layer,
          layerArrayCount: 1,
          baseMipLevel: mipLevel,
          mipLevelCount: 1 };
  
        const srcView = texture.gpuTexture.object.createView(viewDesc);

        self.textureUtils.blitTexture(srcView, texture.format, 1, canvasTexture.createView(), format, texture.display);
      });
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
