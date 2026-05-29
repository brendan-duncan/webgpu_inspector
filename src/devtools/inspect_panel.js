import { Button } from "./widget/button.js";
import { Checkbox } from "./widget/checkbox.js";
import { collapsible } from "./widget/collapsible.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { TabWidget } from "./widget/tab_widget.js";
import { TextInput } from "./widget/text_input.js";
import { Widget } from "./widget/widget.js";
import { Select } from "./widget/select.js";
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
import { getInspectWorkers, setInspectWorkers } from "../utils/inspector_settings.js";
import { Plot } from "./widget/plot.js";
import { Split } from "./widget/split.js";
import { ShaderEditor } from "./shader_editor.js";
import { StacktraceViewer } from './stacktrace_viewer.js';
import { TextureViewer } from "./texture_viewer.js";

export class InspectPanel {
  constructor(win, parent) {
    this.window = win;

    // Prevent the DevTools panel from zooming when CTRL + mouse-wheel is used.
    // It interferes with zooming the texture views.
		this.window.addEventListener("mousewheel", (evt) => {
      if (evt.ctrlKey) {
          evt.preventDefault();
      }
    }, { passive: false });
		this.window.addEventListener("DOMMouseScroll", (evt) => {
      if (evt.ctrlKey) {
          evt.preventDefault();
      }
    }, { passive: false });

    const self = this;
    const _controlBar = new Div(parent, { class: "control-bar" });
    const controlBar = new Div(_controlBar);

    this.inspectButton = new Button(controlBar, { label: "Start", class: "btn btn-success", callback: () => {
      try {
        self._reset();
        self.port.postMessage({
          action: PanelActions.InitializeInspector,
          inspectWorkers: self._inspectWorkers
        });
      } catch (e) {}
    } });

    // When enabled, Start also injects the inspector into Web Workers created
    // by the page. On by default. The choice is persisted and is read by the
    // Capture panel as well, so a specific-frame capture reload uses the same
    // setting.
    this._inspectWorkers = getInspectWorkers();
    const inspectWorkersCheckbox = new Checkbox(controlBar, {
      label: "Inspect Workers",
      tooltip: "When enabled, Start also injects the inspector into Web Workers created by the page. On by default; turn it off if it interferes with the page.",
      class: "ml-sm mr-sm",
      onChange: (checked) => {
        self._inspectWorkers = !!checked;
        setInspectWorkers(self._inspectWorkers);
      }
    });
    // Set checked state after construction: the Checkbox widget only switches
    // its input to type="checkbox" after options are applied, so a `checked`
    // option passed to the constructor would not stick.
    inspectWorkersCheckbox.checked = this._inspectWorkers;

    const stats = new Span(controlBar, { class: "control-bar-stats" });
    this.uiFrameTime = new Span(stats, { style: "width: 140px; overflow: hidden;" });
    this.uiTotalTextureMemory = new Span(stats, { class: "control-bar-stat" });
    this.uiTotalBufferMemory = new Span(stats, { class: "control-bar-stat" });

    new Span(_controlBar, { class: "control-bar-spacer" });

    new Button(_controlBar, { label: "Help", class: "btn btn-secondary", callback: () => {
      window.open("https://github.com/brendan-duncan/webgpu_inspector/blob/main/docs/inspect.md", "_blank");
    }});

    this.plots = new Div(parent, { style: "display: flex; flex-direction: row; margin-bottom: 10px; margin-top: 0px; padding-top: 0px; height: 30px;" });
    new Span(this.plots, { text: "Frame Time", class: "text-secondary mt-sm mr-sm", style: "font-size: 11pt; color: #ccc;"  });
    this.frameRatePlot = new Plot(this.plots, { precision: 2, suffix: "ms", class: "plot-container", style: "flex-grow: 1; margin-right: 10px; max-width: 500px;" });
    this.frameRateData = this.frameRatePlot.addData("Frame Time");

    this._objectCountType = null;
    this._objectCountObject = null;

    new Select(this.plots, {
      options: ["GPU Objects", "Buffer", "BindGroup", "TextureView", "Texture", "Sampler", "PipelineLayout", "BindGroupLayout", "ShaderModule", "ComputePipeline", "RenderPipeline", "RenderBundle"],
      index: 0,
      class: "text-secondary mt-sm mr-sm",
      style: "padding: 0px; margin: 0px;",
      onChange: (value) => {
        self._changeObjectCountPlot(value);
      } });
    this.objectCountPlot = new Plot(this.plots, { class: "plot-container", style: "flex-grow: 1; max-width: 500px;" });
    this.objectCountData = this.objectCountPlot.addData("Object Count");
    this._changeObjectCountPlot(0);

    this.inspectorGUI = new Div(parent, { style: "overflow: hidden; white-space: nowrap; flex: 1 1 auto; min-height: 0; display: flex;" });

    this.database.onObjectLabelChanged.addListener(this._objectLabelChanged, this);
    this.database.onAddObject.addListener(this._addObject, this);
    this.database.onDeleteObject.addListener(this._deleteObject, this);
    this.database.onDeltaFrameTime.addListener(this._updateFrameStats, this);
    this.database.onValidationError.addListener(this._validationError, this);
    this.database.onResolvePendingObject.addListener(this._resolvePendingObject, this);
    this.database.onCapturedObjectsChanged.addListener(this._capturedObjectsChanged, this);

    // Keep track of previously inspected objects for history navigation.
    this._inspectedObjectBack = [];
    this._inspectedObjectForward = [];
    this._maxInspectedObjectHistory = 20;

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

  inspectObject(object, skipHistory) {
    // Procedurally inspect an object an object by simulating a click
    // on its Objects list widget. This will ensure the Objects list item
    // is expanded and selected.
    if (object?.widget) {
      object.widget.group.expand();
      object.skipHistory = skipHistory;
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

    this._inspectedObjectBack = [];
    this._inspectedObjectForward = [];
    this._updateHistoryButtons();

    this._selectedObject = null;
    this._selectedGroup = null;
    this._resetFilterState();
    this.inspectorGUI.html = "";

    const split = new Split(this.inspectorGUI, { direction: Split.Horizontal, position: 340 });

    const pane1 = new Span(split);

    const self = this;

    const objectsTab = new TabWidget(pane1);
    const objectsPanel = new Div(null, { style: "font-size: 11pt; overflow: auto; height: calc(-115px + 100vh);" });
    objectsTab.addTab("Objects", objectsPanel);

    this._backButton = new Button(objectsTab.headerElement, { label: "<", style: "font-weight: bold;", tooltip: "Back", disabled: true, callback: () => {
      const previousObject = self._inspectedObjectBack.pop();
      self._updateHistoryButtons();
      if (previousObject) {
        self._inspectedObjectForward.push(self.inspectedObject);
        self.inspectObject(previousObject, true);
      }
    }});
    this._forwardButton = new Button(objectsTab.headerElement, { label: ">", class: "font-bold", tooltip: "Forward", disabled: true, callback: () => {
      const nextObject = self._inspectedObjectForward.pop();
      self._updateHistoryButtons();
      if (nextObject) {
        self._inspectedObjectBack.push(self.inspectedObject);
        self.inspectObject(nextObject, true);
      }
    }});

    const pane2 = new Span(split, { style: "flex-grow: 1; overflow: hidden;" });

    const inspectTab = new TabWidget(pane2, { class: "inspector-tabs" });
    this.inspectPanel = new Div(null, { class: "inspector_panel_content" });
    inspectTab.addTab("Inspect", this.inspectPanel);

    this._buildFilterUI(objectsPanel);

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

    this._objectListUIs = [
      this.uiAdapters, this.uiDevices, this.uiRenderPipelines, this.uiComputePipelines,
      this.uiShaderModules, this.uiBuffers, this.uiTextures, this.uiTextureViews,
      this.uiSamplers, this.uiBindGroups, this.uiBindGroupLayouts, this.uiPipelineLayouts,
      this.uiRenderBundles, this.uiPendingAsyncRenderPipelines,
      this.uiPendingAsyncComputePipelines, this.uiValidationErrors
    ];
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
    this._applyFilterToObject(object);
  }

  _capturedObjectsChanged() {
    if (this._filters && this._filters.onlyInLastCapture) {
      this._applyFilters();
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
        this._inspectedInfoBox.classList.add("info-box-error");
      }
    }

    // Remove the deleted object from the inspection history.
    if (this._inspectedObjectBack.indexOf(object) !== -1) {
      this._inspectedObjectBack = this._inspectedObjectBack.filter((o) => o !== object);
    }
    if (this._inspectedObjectForward.indexOf(object) !== -1) {
      this._inspectedObjectForward = this._inspectedObjectForward.filter((o) => o !== object);
    }
    this._updateHistoryButtons();
  }

  _updateObjectStat(object) {
    if (object instanceof Adapter) {
      this._setListLabel(this.uiAdapters, "Adapters", this.database.adapters.size);
    } else if (object instanceof Device) {
      this._setListLabel(this.uiDevices, "Devices", this.database.devices.size);
    } else if (object instanceof Buffer) {
      this._setListLabel(this.uiBuffers, "Buffers", this.database.buffers.size);
    } else if (object instanceof Sampler) {
      this._setListLabel(this.uiSamplers, "Samplers", this.database.samplers.size);
    } else if (object instanceof Texture) {
      this._setListLabel(this.uiTextures, "Textures", this.database.textures.size);
    } else if (object instanceof TextureView) {
      this._setListLabel(this.uiTextureViews, "Texture Views", this.database.textureViews.size);
    } else if (object instanceof ShaderModule) {
      this._setListLabel(this.uiShaderModules, "Shader Modules", this.database.shaderModules.size);
    } else if (object instanceof BindGroupLayout) {
      this._setListLabel(this.uiBindGroupLayouts, "Bind Group Layouts", this.database.bindGroupLayouts.size);
    } else if (object instanceof PipelineLayout) {
      this._setListLabel(this.uiPipelineLayouts, "Pipeline Layouts", this.database.pipelineLayouts.size);
    } else if (object instanceof BindGroup) {
      this._setListLabel(this.uiBindGroups, "Bind Groups", this.database.bindGroups.size);
    } else if (object instanceof RenderPipeline) {
      this._setListLabel(this.uiPendingAsyncRenderPipelines, "Pending Async Render Pipelines", this.database.pendingRenderPipelines.size);
      this._setListLabel(this.uiRenderPipelines, "Render Pipelines", this.database.renderPipelines.size);
    } else if (object instanceof ComputePipeline) {
      this._setListLabel(this.uiPendingAsyncComputePipelines, "Pending Async Compute Pipelines", this.database.pendingComputePipelines.size);
      this._setListLabel(this.uiComputePipelines, "Compute Pipelines", this.database.computePipelines.size);
    } else if (object instanceof ValidationError) {
      this._setListLabel(this.uiValidationErrors, "Validation Errors", this.database.validationErrors.size);
    } else if (object instanceof RenderBundle) {
      this._setListLabel(this.uiRenderBundles, "Render Bundles", this.database.renderBundles.size);
    }
  }

  _setListLabel(ui, name, total) {
    if (!ui) {
      return;
    }
    ui._labelName = name;
    ui._labelTotal = total;
    if (this._isFilterActive() && ui._labelVisible !== undefined && ui._labelVisible !== total) {
      ui.label.text = `${name} ${ui._labelVisible}/${total}`;
    } else {
      ui.label.text = `${name} ${total}`;
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
    const panel = new collapsible(parent, { collapsed: true, label: `${name} 0` });
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

  _updateHistoryButtons() {
    if (!this._backButton)
      return;
    this._backButton.disabled = this._inspectedObjectBack.length === 0;
    this._forwardButton.disabled = this._inspectedObjectForward.length === 0;
  }

  // Adds an object to the Objects list.
  _addObjectToUI(object, ui) {
    let name = `${object.name}`;
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
        if (!object.label) {
          name = texture.name;
        }
        type += ` Texture:${texture.idName} ${texture.descriptor.format} ${texture.resolutionString}`;
      }
    } else if (object instanceof Buffer) {
      type += ` size:${object.descriptor?.size ?? "?"}`;

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
      widget.idWidget = new Span(widget, { text: `ID:${idName}`, class: "object-item-id" });
      widget.typeWidget = new Span(widget, { text: type, class: "object-item-type" });
    }

    object.widget = widget;
    widget.group = ui;

    this._applyFilterToObject(object);

    const self = this;
    object.widget.element.onclick = () => {
      if (self._selectedObject && self._selectedObject.widget) {
        self._selectedObject.widget.element.classList.remove("selected");
      }
      object.widget.element.classList.add("selected");
      // Track the previously inspected object in the history stack.
      if (!object.skipHistory) {
        if (this.database.inspectedObject) {
          this._inspectedObjectBack.push(this.database.inspectedObject);
          if (this._inspectedObjectBack.length > this._maxInspectedObjectHistory) {
            this._inspectedObjectBack.shift();
          }
        }
      } else {
        object.skipHistory = false;
      }
      self._updateHistoryButtons();
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

  _resetFilterState() {
    this._filters = {
      search: "",
      onlyInLastCapture: false,
      texture: { format: "", width: "", height: "", depth: "" },
      buffer: { size: "", usageMask: 0 },
      shaderModule: { vertex: false, fragment: false, compute: false },
      bindGroup: { contains: "" }
    };
  }

  _isFilterActive() {
    const f = this._filters;
    if (!f) {
      return false;
    }
    if (f.search) return true;
    if (f.onlyInLastCapture) return true;
    if (f.texture.format || f.texture.width || f.texture.height || f.texture.depth) return true;
    if (f.buffer.size || f.buffer.usageMask) return true;
    if (f.shaderModule.vertex || f.shaderModule.fragment || f.shaderModule.compute) return true;
    if (f.bindGroup.contains) return true;
    return false;
  }

  _parseNumericFilter(str) {
    if (!str) return null;
    str = str.trim();
    if (!str) return null;
    const match = /^(>=|<=|>|<|=)?\s*(-?\d+(?:\.\d+)?)\s*$/.exec(str);
    if (!match) return null;
    return { op: match[1] || "=", value: Number(match[2]) };
  }

  _numericMatches(filter, n) {
    if (!filter) return true;
    if (typeof n !== "number" || isNaN(n)) return false;
    switch (filter.op) {
      case ">=": return n >= filter.value;
      case "<=": return n <= filter.value;
      case ">": return n > filter.value;
      case "<": return n < filter.value;
      default: return n === filter.value;
    }
  }

  _buildFilterUI(parent) {
    const self = this;
    const panel = new collapsible(parent, { collapsed: true, label: "Filter", class: "inspector-filter-collapsible" });
    panel.body.style.maxHeight = "unset";
    panel.body.style.padding = "6px 10px 10px 10px";
    this._filterPanel = panel;

    const onChange = () => self._applyFilters();

    const addField = (row, labelText, labelClass, makeChild) => {
      const field = new Div(row, { class: "inspector-filter-field" });
      new Span(field, { text: labelText, class: labelClass });
      makeChild(field);
      return field;
    };

    // Common search row.
    const row1 = new Div(panel.body, { class: "inspector-filter-row" });
    addField(row1, "Search:", "inspector-filter-label", (field) => {
      new TextInput(field, {
        placeholder: "name or id",
        class: "inspector-filter-input",
        onEdit: (value) => {
          self._filters.search = (value ?? "").trim();
          onChange();
        }
      });
    });

    const row2 = new Div(panel.body, { class: "inspector-filter-row" });
    const captureCheckbox = new Checkbox(row2, {
      label: "Only objects used in last capture",
      class: "inspector-filter-field",
      onChange: (checked) => {
        self._filters.onlyInLastCapture = !!checked;
        onChange();
      }
    });
    this._captureFilterCheckbox = captureCheckbox;

    // Texture filters.
    const texGrp = new collapsible(panel.body, { collapsed: true, label: "Textures / Views" });
    texGrp.body.style.padding = "4px 10px";
    const texRow = new Div(texGrp.body, { class: "inspector-filter-row" });
    addField(texRow, "Format:", "inspector-filter-label-sm", (field) => {
      new TextInput(field, {
        placeholder: "e.g. rgba8unorm",
        class: "inspector-filter-input-sm",
        onEdit: (v) => { self._filters.texture.format = (v ?? "").trim().toLowerCase(); onChange(); }
      });
    });
    addField(texRow, "Width:", "inspector-filter-label-sm", (field) => {
      new TextInput(field, {
        placeholder: ">=256",
        class: "inspector-filter-input-sm",
        onEdit: (v) => { self._filters.texture.width = (v ?? "").trim(); onChange(); }
      });
    });
    addField(texRow, "Height:", "inspector-filter-label-sm", (field) => {
      new TextInput(field, {
        placeholder: ">=256",
        class: "inspector-filter-input-sm",
        onEdit: (v) => { self._filters.texture.height = (v ?? "").trim(); onChange(); }
      });
    });
    addField(texRow, "Depth:", "inspector-filter-label-sm", (field) => {
      new TextInput(field, {
        placeholder: ">1",
        class: "inspector-filter-input-sm",
        onEdit: (v) => { self._filters.texture.depth = (v ?? "").trim(); onChange(); }
      });
    });

    // Buffer filters.
    const bufGrp = new collapsible(panel.body, { collapsed: true, label: "Buffers" });
    bufGrp.body.style.padding = "4px 10px";
    const bufRow = new Div(bufGrp.body, { class: "inspector-filter-row" });
    addField(bufRow, "Size:", "inspector-filter-label-sm", (field) => {
      new TextInput(field, {
        placeholder: ">=1024",
        class: "inspector-filter-input-sm",
        onEdit: (v) => { self._filters.buffer.size = (v ?? "").trim(); onChange(); }
      });
    });
    const bufRow2 = new Div(bufGrp.body, { class: "inspector-filter-row" });
    new Span(bufRow2, { text: "Usage:", class: "inspector-filter-label-sm" });
    const bufferUsages = [
      { label: "Index", flag: GPUBufferUsage.INDEX },
      { label: "Vertex", flag: GPUBufferUsage.VERTEX },
      { label: "Uniform", flag: GPUBufferUsage.UNIFORM },
      { label: "Storage", flag: GPUBufferUsage.STORAGE },
      { label: "Indirect", flag: GPUBufferUsage.INDIRECT },
      { label: "QueryResolve", flag: GPUBufferUsage.QUERY_RESOLVE }
    ];
    for (const usage of bufferUsages) {
      new Checkbox(bufRow2, {
        label: usage.label,
        class: "inspector-filter-field",
        onChange: (checked) => {
          if (checked) {
            self._filters.buffer.usageMask |= usage.flag;
          } else {
            self._filters.buffer.usageMask &= ~usage.flag;
          }
          onChange();
        }
      });
    }

    // Shader Module filters.
    const shaderGrp = new collapsible(panel.body, { collapsed: true, label: "Shader Modules" });
    shaderGrp.body.style.padding = "4px 10px";
    const shaderRow = new Div(shaderGrp.body, { class: "inspector-filter-row" });
    new Span(shaderRow, { text: "Type:", class: "inspector-filter-label-sm" });
    new Checkbox(shaderRow, {
      label: "Vertex",
      class: "inspector-filter-field",
      onChange: (checked) => { self._filters.shaderModule.vertex = !!checked; onChange(); }
    });
    new Checkbox(shaderRow, {
      label: "Fragment",
      class: "inspector-filter-field",
      onChange: (checked) => { self._filters.shaderModule.fragment = !!checked; onChange(); }
    });
    new Checkbox(shaderRow, {
      label: "Compute",
      class: "inspector-filter-field",
      onChange: (checked) => { self._filters.shaderModule.compute = !!checked; onChange(); }
    });

    // Bind group filters.
    const bgGrp = new collapsible(panel.body, { collapsed: true, label: "Bind Groups" });
    bgGrp.body.style.padding = "4px 10px";
    const bgRow = new Div(bgGrp.body, { class: "inspector-filter-row" });
    addField(bgRow, "Contains:", "inspector-filter-label-sm", (field) => {
      new TextInput(field, {
        placeholder: "name or id of resource",
        class: "inspector-filter-input",
        onEdit: (v) => { self._filters.bindGroup.contains = (v ?? "").trim().toLowerCase(); onChange(); }
      });
    });
  }

  _matchesString(haystack, needle) {
    if (!needle) return true;
    if (!haystack) return false;
    return String(haystack).toLowerCase().includes(needle.toLowerCase());
  }

  _bindGroupContainsMatch(bindGroup, query) {
    const entries = bindGroup.descriptor?.entries;
    if (!entries) return false;
    query = query.toLowerCase();
    for (const entry of entries) {
      const resource = entry.resource;
      if (!resource) continue;
      let id = null;
      if (resource.buffer?.__id !== undefined) {
        id = resource.buffer.__id;
      } else if (resource.__id !== undefined) {
        id = resource.__id;
      }
      if (id === null) continue;
      const obj = this.database.getObject(id);
      if (!obj) continue;
      if (String(obj.idName).toLowerCase().includes(query)) {
        return true;
      }
      if ((obj.label || "").toLowerCase().includes(query)) {
        return true;
      }
      if (obj instanceof TextureView) {
        const tex = this.database.getTextureFromView(obj);
        if (tex) {
          if (String(tex.idName).toLowerCase().includes(query)) return true;
          if ((tex.label || "").toLowerCase().includes(query)) return true;
        }
      }
    }
    return false;
  }

  _filterMatches(object) {
    const f = this._filters;
    if (!f) return true;

    // Global search applies to all object types.
    if (f.search) {
      const q = f.search.toLowerCase();
      const nameMatch = (object.label || "").toLowerCase().includes(q) ||
                        object.constructor.className.toLowerCase().includes(q);
      const idMatch = String(object.idName).toLowerCase().includes(q);
      if (!nameMatch && !idMatch) {
        return false;
      }
    }

    if (f.onlyInLastCapture) {
      if (!this.database.capturedObjects.has(object.id)) {
        return false;
      }
    }

    // Type-specific filters.
    if (object instanceof Texture) {
      if (!this._textureMatchesFilter(object)) return false;
    } else if (object instanceof TextureView) {
      const tex = this.database.getTextureFromView(object);
      if (tex) {
        if (!this._textureMatchesFilter(tex)) return false;
      } else if (f.texture.format || f.texture.width || f.texture.height || f.texture.depth) {
        return false;
      }
    } else if (object instanceof Buffer) {
      if (!this._bufferMatchesFilter(object)) return false;
    } else if (object instanceof ShaderModule) {
      if (!this._shaderModuleMatchesFilter(object)) return false;
    } else if (object instanceof BindGroup) {
      if (f.bindGroup.contains) {
        if (!this._bindGroupContainsMatch(object, f.bindGroup.contains)) {
          return false;
        }
      }
    }

    return true;
  }

  _textureMatchesFilter(texture) {
    const f = this._filters.texture;
    if (f.format && !this._matchesString(texture.format, f.format)) return false;
    const wf = this._parseNumericFilter(f.width);
    if (wf && !this._numericMatches(wf, texture.width)) return false;
    const hf = this._parseNumericFilter(f.height);
    if (hf && !this._numericMatches(hf, texture.height)) return false;
    const df = this._parseNumericFilter(f.depth);
    if (df && !this._numericMatches(df, texture.depthOrArrayLayers)) return false;
    return true;
  }

  _bufferMatchesFilter(buffer) {
    const f = this._filters.buffer;
    if (f.size) {
      const sf = this._parseNumericFilter(f.size);
      if (sf && !this._numericMatches(sf, buffer.descriptor?.size ?? 0)) return false;
    }
    if (f.usageMask) {
      const usage = buffer.descriptor?.usage ?? 0;
      if ((usage & f.usageMask) === 0) return false;
    }
    return true;
  }

  _shaderModuleMatchesFilter(shader) {
    const f = this._filters.shaderModule;
    if (!f.vertex && !f.fragment && !f.compute) return true;
    if (f.vertex && shader.hasVertexEntries) return true;
    if (f.fragment && shader.hasFragmentEntries) return true;
    if (f.compute && shader.hasComputeEntries) return true;
    return false;
  }

  _applyFilterToObject(object) {
    const widget = object?.widget;
    if (!widget || !widget.element) return;
    // Hidden state for deleted objects is managed separately. Don't override it.
    if (widget.element.style.display === "none" && object.isDeleted) return;

    const match = this._filterMatches(object);
    widget.element.style.display = match ? "list-item" : "none";
    return match;
  }

  _applyFilters() {
    if (!this._objectListUIs) return;
    const filterActive = this._isFilterActive();

    // Iterate objects by type for accurate counts.
    const buckets = [
      { ui: this.uiAdapters, map: this.database.adapters },
      { ui: this.uiDevices, map: this.database.devices },
      { ui: this.uiRenderPipelines, map: this.database.renderPipelines },
      { ui: this.uiComputePipelines, map: this.database.computePipelines },
      { ui: this.uiShaderModules, map: this.database.shaderModules },
      { ui: this.uiBuffers, map: this.database.buffers },
      { ui: this.uiTextures, map: this.database.textures },
      { ui: this.uiTextureViews, map: this.database.textureViews },
      { ui: this.uiSamplers, map: this.database.samplers },
      { ui: this.uiBindGroups, map: this.database.bindGroups },
      { ui: this.uiBindGroupLayouts, map: this.database.bindGroupLayouts },
      { ui: this.uiPipelineLayouts, map: this.database.pipelineLayouts },
      { ui: this.uiRenderBundles, map: this.database.renderBundles },
      { ui: this.uiPendingAsyncRenderPipelines, map: this.database.pendingRenderPipelines },
      { ui: this.uiPendingAsyncComputePipelines, map: this.database.pendingComputePipelines },
      { ui: this.uiValidationErrors, map: this.database.validationErrors }
    ];

    for (const bucket of buckets) {
      const { ui, map } = bucket;
      if (!ui) continue;
      let visible = 0;
      let total = 0;
      map.forEach((obj) => {
        if (!obj.widget || !obj.widget.element) return;
        total++;
        const match = this._filterMatches(obj);
        obj.widget.element.style.display = match ? "list-item" : "none";
        if (match) visible++;
      });
      ui._labelVisible = visible;
      ui._labelTotal = total;
      const name = ui._labelName;
      if (name !== undefined) {
        if (filterActive && visible !== total) {
          ui.label.text = `${name} ${visible}/${total}`;
        } else {
          ui.label.text = `${name} ${total}`;
        }
      }
    }
  }

  _getcollapsibleWithState(parent, object, property, label, collapsed) {
    object.__guistate = object.__guistate || {};
    object.__guistate[property] = object.__guistate[property] ?? collapsed;
    const collabsable = new collapsible(parent, { collapsed: true, label: label, collapsed: object.__guistate[property] });
    collabsable.onExpanded.addListener(() => {
      object.__guistate[property] = false;
    });
    collabsable.onCollapsed.addListener(() => {
      object.__guistate[property] = true;
    });
    return collabsable;
  }

  _inspectObject(object) {
    this.inspectPanel.html = "";

    this.database.inspectedObject = object;

    let name = object.name;
    if (object instanceof TextureView) {
      const texture = this.database.getTextureFromView(object);
      if (texture) {
        name = texture.name;
      }
    }

    const infoBox = new Div(this.inspectPanel, { class: object.isDeleted ? "info-box info-box-error" : "info-box info-box-success", style: "flex: 0 0 auto;" });
    const idName = object.idName;
    new Div(infoBox, { text: `${name} ID: ${idName} ${object.isDeleted ? "<deleted>" : ""}` });
    this._inspectedInfoBox = infoBox;

    if (object instanceof Texture) {
      const gpuSize = object.getGpuSize();
      const sizeStr = gpuSize < 0 ? "<unknown>" : gpuSize.toLocaleString("en-US");
      new Div(infoBox, { text: `GPU Size: ${sizeStr} Bytes`, style: "font-size: 10pt; margin-top: 5px;" });
    }

    const dependencies = this.database.getObjectDependencies(object);
    new Div(infoBox, { text: `Reference Count: ${object.referenceCount}`, class: "font-md text-muted" });

    if (object instanceof RenderBundle) {
      new Div(infoBox, { text: `Bundle Commands: ${object.commands.length}`, class: "font-md text-muted" });
    }

    const depGrp = new Div(infoBox, { class: "font-md text-muted pl-md", style: "max-height: 50px; overflow: auto;" })
    for (const dep of dependencies) {
      new Div(depGrp, { text: `${dep.name} ${dep.idName}` });
    }

    if (object.stacktrace) {
      new StacktraceViewer(this, infoBox, object, object.stacktrace);
    }

    const errorLines = [];

    const errors = this.database.findObjectErrors(object.id);
    if (errors.length > 0) {
      const errorsGrp = this._getcollapsibleWithState(infoBox, object, "errorsCollapsed", "Errors", true);
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

    if (object instanceof RenderPipeline || object instanceof ComputePipeline) {
      const grp = this._getcollapsibleWithState(infoBox, object, "dependenciesCollapsed", "Dependencies", true);
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
      if (descriptor.compute) {
        const obj = this.database.getObject(descriptor.compute.module.__id);
        if (obj) {
          createDependencyLink(obj, `Compute Module: ${obj.name}(${obj.idName})`, ul);
        }
      }
    }

    if (object instanceof PipelineLayout) {
      const grp = this._getcollapsibleWithState(infoBox, object, "dependenciesCollapsed", "Dependencies", true);
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
      const grp = this._getcollapsibleWithState(infoBox, object, "dependenciesCollapsed", "Dependencies", true);
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
        const grp = this._getcollapsibleWithState(infoBox, object, "reflectionInfoCollapsed", "Reflection Info", true);
        grp.body.style.maxHeight = "600px";
        grp.body.style.fontSize = "10pt";

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
    }

    const descriptionBox = new Div(this.inspectPanel, { style: "flex: 1 1 auto; min-height: 150px; overflow: auto;" });

    if (object instanceof ShaderModule) {
      const self = this;
      new ShaderEditor(this, descriptionBox, object, () => {
        self._inspectObject(object);
      });
    } else if (object instanceof ValidationError) {
      const objectId = object.object;
      if (objectId) {
        const obj = this.database.getObject(objectId);
        if (obj) {
          const self = this;
          new Button(infoBox, { label: `${obj.name}.${obj.idName}`, class: "btn btn-danger" , callback: () => {
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
      new Widget("pre", descriptionBox, { text, class: "validation-error" });
    } else {
      const grp = this._getcollapsibleWithState(descriptionBox, object, "descriptorCollapsed", "Descriptor", false);
      const desc = this._getDescriptorInfo(object, object.descriptor);
      const text = JSON.stringify(desc, undefined, 4);
      new Widget("pre", grp.body, { class: "descriptor-info", text });
    }

    if (object instanceof RenderBundle) {

    } else if (object instanceof Texture) {
      const self = this;
      const loadButton = new Button(descriptionBox, { label: "Load", class: "btn", callback: () => {
        self.database.requestTextureData(object, object.display?.mipLevel ?? 0);
      }});
      if (object.gpuTexture) {
        new TextureViewer(this, descriptionBox, object);
      } else if (!loadButton.disabled) {
        // Auto-load the texture if it's not a depth-stencil texture
        this.database.requestTextureData(object, object.display?.mipLevel ?? 0);
      }
    } else if (object instanceof TextureView) {
      const texture = this.database.getTextureFromView(object);
      if (texture) {
        const textureGrp = this._getcollapsibleWithState(descriptionBox, object, "textureCollapsed", `Texture ID: ${texture.idName} ${texture.dimension} ${texture.format} ${texture.resolutionString}`, false);
        textureGrp.body.style.maxHeight = "unset";

        const desc = this._getDescriptorInfo(texture, texture.descriptor);
        const text = JSON.stringify(desc, undefined, 4);
        new Widget("pre", textureGrp.body, { text, style: "font-size: 10pt;" });

        const self = this;

        const loadButton = new Button(textureGrp.body, { label: "Load", class: "btn", callback: () => {
          self.database.requestTextureData(texture);
        }});

        if (texture.gpuTexture) {
          new TextureViewer(this, textureGrp.body, texture);
        } else if (!loadButton.disabled) {
          // Auto-load the texture if it's not a depth-stencil texture
          this.database.requestTextureData(texture);
        }
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
