import { Button } from "./widget/button.js";
import { Div } from "./widget/div.js";
import { HSplit } from "./widget/hsplit.js";
import { Input } from "./widget/input.js";
import { Span } from "./widget/span.js";
import { Widget } from "./widget/widget.js";
import { Window } from "./widget/window.js";
import { TabWidget } from "./widget/tab_widget.js";
import { VSplit } from "./widget/vsplit.js";
import { Buffer, Sampler, Texture, ShaderModule, BindGroupLayout, PipelineLayout, BindGroup, RenderPipeline, ComputePipeline } from "./object_database.js";

export class InspectorWindow extends Window {
  constructor(database, port, tabId) {
    super();

    this.database = database
    this.classList.add("main-window");
    this._selectedObject = null;

    const tabs = new TabWidget(this);

    const inspectorPanel = new Div();
    tabs.addTab("Inspector", inspectorPanel);

    const recorderPanel = new VSplit(null, { fixedPosition: 100 });
    tabs.addTab("Recorder", recorderPanel);

    this._buildInspectorPanel(port, tabId, inspectorPanel);
    this._buildRecorderPanel(port, tabId, recorderPanel);

    this._resetInspectorPanel();

    this.database.onEndFrame.addListener(this._updateFrameStats, this);
    this.database.onAddObject.addListener(this._addObject, this);
    this.database.onDeleteObject.addListener(this._deleteObject, this);
  }

  _buildInspectorPanel(port, tabId, inspectorPanel) {
    const self = this;
    const controlBar = new Div(inspectorPanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    this.inspectButton = new Button(controlBar, { label: "Start", callback: () => { 
      try {
        port.postMessage({ action: "initialize_inspector", tabId });
        self._resetInspectorPanel();
      } catch (e) {}
    } });    

    this.inspectorGUI = new Div(inspectorPanel, { style: "overflow: auto; white-space: nowrap; height: calc(-85px + 100vh);" });
  }

  _buildRecorderPanel(port, tabId, recorderPanel) {
    const self = this;
    const recorderBar = new Div(recorderPanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    new Span(recorderBar, { text: "Frames:", style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
    this.recordFramesInput = new Input(recorderBar, { id: "record_frames", type: "number", value: 100 });

    new Span(recorderBar, { text: "Name:", style: "margin-left: 20px; margin-right: 10px;  vertical-align: middle;" });
    this.recordNameInput = new Input(recorderBar, { id: "record_frames", type: "text", value: "webgpu_record" });

    this._recordingData = [];

    this.recordButton = new Button(recorderBar, { label: "Record", style: "margin-left: 20px; margin-right: 10px;", callback: () => {
      const frames = self.recordFramesInput.value || 1;
      const filename = self.recordNameInput.value;
      self._recordingData.length = 0;
      port.postMessage({ action: "initialize_recorder", frames, filename, tabId });
    }});

    this.recorderDataPanel = new Div(recorderPanel);

    port.onMessage.addListener((message) => {
      switch (message.action) {
        case "webgpu_recording":
          if (message.index !== undefined && message.count !== undefined && message.data !== undefined) {
            self.addRecordingData(message.data, message.index, message.count);
          }
          break;
      }
    });
  }

  _encodeBase64(bytes) {
    const _b2a = [
        "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
        "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
        "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "/"
    ];

    let result = '', i, l = bytes.length;
    for (i = 2; i < l; i += 3) {
        result += _b2a[bytes[i - 2] >> 2];
        result += _b2a[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
        result += _b2a[((bytes[i - 1] & 0x0F) << 2) | (bytes[i] >> 6)];
        result += _b2a[bytes[i] & 0x3F];
    }
    if (i === l + 1) {
        result += _b2a[bytes[i - 2] >> 2];
        result += _b2a[(bytes[i - 2] & 0x03) << 4];
        result += "==";
    }
    if (i === l) {
        result += _b2a[bytes[i - 2] >> 2];
        result += _b2a[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
        result += _b2a[(bytes[i - 1] & 0x0F) << 2];
        result += "=";
    }
    return result;
}

  addRecordingData(data, index, count) {
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
    /*const nonceData = new Uint8Array(16);
    const nonce = this._encodeBase64(crypto.getRandomValues(nonceData));
    const html = this._recordingData.join().replace("<script>", `<script nonce="${nonce}">`).replace("script-src *", `script-src * 'nonce-${nonce}' strict-dynamic`);

    const f = document.createElement("iframe");
    f.sandbox = "allow-scripts";
    //const url = 'data:text/html;charset=utf-8,' + encodeURI(html);
    const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
    f.src = url;

    new Widget(f, this.recorderDataPanel, { style: "width: calc(100% - 10px);" });

    //f.contentWindow.document.open();
    //f.contentWindow.document.write(html);
    //f.contentWindow.document.close();
    */
  }

  _resetInspectorPanel() {
    this._selectedObject = null;
    this._selectedGroup = null;
    this.inspectorGUI.html = "";

    const pane1 = new Span(this.inspectorGUI, { style: "margin-right: 10px;" });

    this.infoPanel = new Div(null, { class: "info-panel" });
    const infoTab = new TabWidget(pane1);
    infoTab.addTab("Stats", this.infoPanel);

    let div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Frame Duration:", style: "color: #bbb;" });
    this.uiFrameTime = new Span(div, { text: "0ms", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel);
    new Span(div, { text: "Frame Render Passes:", style: "color: #bbb;" });
    this.uiFrameRenderPasses = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Render Pipelines:", style: "color: #bbb;" });
    this.uiRenderPipelinesStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Compute Pipelines:", style: "color: #bbb;" });
    this.uiComputePipelinesStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Shader Modules:", style: "color: #bbb;" });
    this.uiShaderModulesStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Buffers:", style: "color: #bbb;" });
    this.uiBuffersStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Textures:", style: "color: #bbb;" });
    this.uiTexturesStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Samplers:", style: "color: #bbb;" });
    this.uiSamplersStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div,{ text: "BindGroups:", style: "color: #bbb;" });
    this.uiBindGroupsStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div,{ text: "BindGroupLayouts:", style: "color: #bbb;" });
    this.uiBindGroupLayoutsStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div,{ text: "PipelineLayouts:", style: "color: #bbb;" });
    this.uiPipelineLayoutsStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Pending Async Render Pipelines:", style: "color: #bbb;" });
    this.uiPendingRenderPipelinesStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Pending Async Compute Pipelines:", style: "color: #bbb;" });
    this.uiPendingComputePipelinesStat = new Span(div, { text: "0", style: "margin-left: 5px;" });


    const pane2 = new Span(this.inspectorGUI, { style: "" });

    const objectsTab = new TabWidget(pane2);
    const objectsPanel = new Div(null, { style: "font-size: 11pt;"});
    objectsTab.addTab("Objects", objectsPanel);

    const pane3 = new Span(this.inspectorGUI, { style: "padding-left: 20px;" });

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
    this.uiSamplers = this._createObjectListUI(objectsPanel, "Samplers");
    this.uiBindGroups = this._createObjectListUI(objectsPanel, "BindGroups");
    this.uiBindGroupLayouts = this._createObjectListUI(objectsPanel, "BindGroupLayouts");
    this.uiPipelineLayouts = this._createObjectListUI(objectsPanel, "PipelineLayouts");
    this.uiPendingAsyncRenderPipelines = this._createObjectListUI(objectsPanel, "Pending Async Render Pipelines");
    this.uiPendingAsyncComputePipelines = this._createObjectListUI(objectsPanel, "Pending Async Compute Pipelines");
  }

  _updateFrameStats() {
    this.uiFrameTime.text = `${this.database.frameTime.toFixed(2)}ms`;
    this.uiFrameRenderPasses.text =
      this.database.renderPassCount.toLocaleString("en-US");
  }

  _deleteObject(id, object) {
    object?.widget?.remove();
    this._updateObjectStat(object);
  }

  _updateObjectStat(object) {
    if (object instanceof Buffer) {
      this.uiBuffersStat.text = `${this.database.buffers.size}`;
      this.uiBuffers.count.text = `${this.database.buffers.size}`;
    } else if (object instanceof Sampler) {
      this.uiSamplersStat.text = `${this.database.samplers.size}`;
      this.uiSamplers.count.text = `${this.database.samplers.size}`;
    } else if (object instanceof Texture) {
      this.uiTexturesStat.text = `${this.database.buffers.size}`;
      this.uiTextures.count.text = `${this.database.textures.size}`;
    } else if (object instanceof ShaderModule) {
      this.uiShaderModulesStat.text = `${this.database.shaderModules.size}`;
      this.uiShaderModules.count.text = `${this.database.shaderModules.size}`;
    } else if (object instanceof BindGroupLayout) {
      this.uiBindGroupLayouts.count.text = `${this.database.bindGroupLayouts.size}`;
    } else if (object instanceof PipelineLayout) {
      this.uiPipelineLayouts.count.text = `${this.database.pipelineLayouts.size}`;
    } else if (object instanceof BindGroup) {
      this.uiBindGroupsStat.text = `${this.database.bindGroups.size}`;
      this.uiBindGroups.count.text = `${this.database.bindGroups.size}`;
    } else if (object instanceof RenderPipeline) {
      this.uiPendingRenderPipelinesStat.text = `${this.database.pendingRenderPipelines.size}`;
      this.uiRenderPipelinesStat.text = `${this.database.renderPipelines.size}`;
      this.uiPendingAsyncRenderPipelines.count.text = `${this.database.pendingRenderPipelines.size}`;
      this.uiRenderPipelines.count.text = `${this.database.renderPipelines.size}`;
    } else if (object instanceof ComputePipeline) {
      this.uiPendingComputePipelinesStat.text = `${this.database.pendingComputePipelines.size}`;
      this.uiComputePipelinesStat.text = `${this.database.computePipelines.size}`;
      this.uiPendingAsyncComputePipelines.count.text = `${this.database.pendingComputePipelines.size}`;
      this.uiComputePipelines.count.text = `${this.database.computePipelines.size}`;
    }
  }

  _addObject(id, object, pending) {
    this._updateObjectStat(object);
    if (object instanceof Buffer) {
      this._addObjectToUI(id, object, this.uiBuffers);
      this.uiBuffers.count.text = `${this.database.buffers.size}`;
    } else if (object instanceof Sampler) {
      this._addObjectToUI(id, object, this.uiSamplers);
      this.uiSamplers.count.text = `${this.database.samplers.size}`;
    } else if (object instanceof Texture) {
      this._addObjectToUI(id, object, this.uiTextures);
      this.uiTextures.count.text = `${this.database.textures.size}`;
    } else if (object instanceof ShaderModule) {
      this._addObjectToUI(id, object, this.uiShaderModules);
      this.uiShaderModules.count.text = `${this.database.shaderModules.size}`;
    } else if (object instanceof BindGroupLayout) {
      this._addObjectToUI(id, object, this.uiBindGroupLayouts);
      this.uiBindGroupLayouts.count.text = `${this.database.bindGroupLayouts.size}`;
    } else if (object instanceof PipelineLayout) {
      this._addObjectToUI(id, object, this.uiPipelineLayouts);
      this.uiPipelineLayouts.count.text = `${this.database.pipelineLayouts.size}`;
    } else if (object instanceof BindGroup) {
      this._addObjectToUI(id, object, this.uiBindGroups);
      this.uiBindGroups.count.text = `${this.database.bindGroups.size}`;
    } else if (object instanceof RenderPipeline) {
      this._addObjectToUI(id, object, pending ? this.uiPendingAsyncRenderPipelines : this.uiRenderPipelines);
      if (pending) {
        this.uiPendingAsyncRenderPipelines.count.text = `${this.database.pendingRenderPipelines.size}`;
      } else {
        this.uiRenderPipelines.count.text = `${this.database.renderPipelines.size}`;
      }
    } else if (object instanceof ComputePipeline) {
      this._addObjectToUI(id, object, pending ? this.uiPendingAsyncComputePipelines : this.uiComputePipelines);
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

  _inspectObject(id, object) {
    this.inspectPanel.html = "";

    let div = new Div(this.inspectPanel);
    new Span(div, { text: `${object.constructor.name} ${id}` });

    div = new Div(this.inspectPanel);

    if (object instanceof ShaderModule) {
      const descriptor = new Span(div);
      const code = object.descriptor.code;
      descriptor.html = `<pre>${code}</pre>`
    } else {
      const descriptor = new Span(div);
      const desc = this._getDescriptorInfo(object, object.descriptor);
      descriptor.html = `<pre>${JSON.stringify(desc, undefined, 4)}</pre>`;
    }
  }

  _createObjectListUI(parent, name) {
    const div = new Div(parent);

    const titleBar = new Div(div, { class: "title_bar" });
    
    const collapse = new Span(titleBar, { class: "object_list_collapse", text: "+", style: "margin-right: 10px;" })

    const title = new Span(titleBar, { class: "object_type", text: name });
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

    /*collapse.element.onclick = function() {
      if (self._selectedGroup && self._selectedGroup != objectList) {
        self._selectedGroup.collapse.text = "+";
        self._selectedGroup.element.className = "object_list collapsed";
        self._selectedGroup = null;
      }
      if (collapse.text == "-") {
        collapse.text = "+";
        objectList.element.className = "object_list collapsed";
        self._selectedGroup = null;
      } else {
        collapse.text = "-";
        objectList.element.className = "object_list";
        self._selectedGroup = objectList;
      }
    };*/

    return objectList;
  }

  _addObjectToUI(id, object, ui) {
    object.widget = new Widget("li", ui, { text: `${object.constructor.name} ${id}` });
    const self = this;
    object.widget.element.onclick = () => {
      if (self._selectedObject) {
        self._selectedObject.widget.element.classList.remove("selected");
      }
      object.widget.element.classList.add("selected");
      self._selectedObject = object;
      self._inspectObject(id, object);
    };
  }
}
