import { Button } from "./src/widget/button.js";
import { Div } from "./src/widget/div.js";
import { HSplit } from "./src/widget/hsplit.js";
import { Input } from "./src/widget/input.js";
import { Signal } from "./src/widget/signal.js";
import { Span } from "./src/widget/span.js";
import { Widget } from "./src/widget/widget.js";
import { Window } from "./src/widget/window.js";
import { TabWidget } from "./src/widget/tab_widget.js";
import { TreeWidget } from "./src/widget/tree_widget.js";
import { VSplit } from "./src/widget/vsplit.js";

const port = chrome.runtime.connect({ name: "webgpu-inspector-panel" });
const tabId = chrome.devtools.inspectedWindow.tabId;

class Buffer {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

class Sampler {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

class Texture {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

class ShaderModule {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

class BindGroupLayout {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

class BindGroup {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

class PipelineLayout {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

class RenderPipeline {
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.time = 0;
    this.element = null;
  }
}

class ComputePipeline {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

class ObjectDatabase {
  constructor() {
    this.reset();

    this.onDeleteObject = new Signal();
    this.onResolvePendingObject = new Signal();
    this.onAddObject = new Signal();
    this.onBeginFrame = new Signal();
    this.onEndFrame = new Signal();
    this.onBeginRenderPass = new Signal();
    this.onBeginComputePass = new Signal();
    this.onEndPass = new Signal();
    this.onAdapterInfo = new Signal();

    const self = this;
    port.onMessage.addListener((message) => {
      switch (message.action) {
        case "inspect_adapter_info":
          self.setAdapterInfo(message.info);
          break;
        case "inspect_begin_frame":
          self.beginFrame();
          break;
        case "inspect_end_frame":
          self.endFrame();
          break;
        case "inspect_begin_render_pass":
          self.beginRenderPass();
          break;
        case "inspect_begin_compute_pass":
          self.beginComputePass();
          break;
        case "inspect_end":
          self.endPass();
          break;
        case "inspect_delete_object":
          self.deleteObject(message.id);
          break;
        case "inspect_add_object":
          const id = message.id;
          let descriptor = null;
          try {
            descriptor = message.descriptor ? JSON.parse(message.descriptor) : null;
          } catch (e) {
            console.log("@@@@ EXCEPTION", e);
            break;
          }
          switch (message.type) {
            case "ShaderModule": {
              const obj = new ShaderModule(descriptor);
              self.addObject(id, obj);
              obj.size = descriptor?.code?.length ?? 0;
              break;
            }
            case "Buffer": {
              const obj = new Buffer(descriptor);
              self.addObject(id, obj);
              obj.size = descriptor?.size ?? 0;
              break;
            }
            case "Texture": {
              const obj = new Texture(descriptor);
              self.addObject(id, obj);
              break;
            }
            case "Sampler": {
              const obj = new Sampler(descriptor);
              self.addObject(id, obj);
              break;
            }
            case "BindGroup": {
              const obj = new BindGroup(descriptor);
              self.addObject(id, obj);
              break;
            }
            case "BindGroupLayout": {
              const obj = new BindGroupLayout(descriptor);
              self.addObject(id, obj);
              break;
            }
            case "RenderPipeline": {
              const obj = new RenderPipeline(descriptor);
              self.addObject(id, obj);
              break;
            }
            case "ComputePipeline": {
              const obj = new ComputePipeline(descriptor);
              self.addObject(id, obj);
              break;
            }
          }
          break;
      }
    });
  }

  reset() {
    this.adapterInfo = {
      vendor: "",
      architecture: "",
      device: "",
      description: ""
    };

    this.allObjects = new Map();
    this.samplers = new Map();
    this.textures = new Map();
    this.buffers = new Map();
    this.bindGroups = new Map();
    this.bindGroupLayouts = new Map();
    this.shaderModules = new Map();
    this.renderPipelines = new Map();
    this.computePipelines = new Map();
    this.pendingRenderPipelines = new Map();
    this.pendingComputePipelines = new Map();
    this.renderPassCount = 0;
    this.computePassCount = 0;
    this.frameTime = 0;
  }

  setAdapterInfo(info) {
    this.adapterInfo.vendor = info.vendor;
    this.adapterInfo.architecture = info.architecture;
    this.adapterInfo.device = info.device;
    this.adapterInfo.description = info.description;
    this.onAdapterInfo.emit();
  }

  beginFrame() {
    this.startFrameTime = performance.now();
    this.renderPassCount = 0;
    this.onBeginFrame.emit();
  }

  endFrame() {
    this.endFrameTime = performance.now();
    this.frameTime = this.endFrameTime - this.startFrameTime;
    this.onEndFrame.emit();
  }

  beginRenderPass() {
    this.renderPassCount++;
    this.onBeginRenderPass.emit();
  }

  beginComputePass() {
    this.computePassCount++;
    this.onBeginComputePass.emit();
  }

  endPass() {
    this.onEndPass.emit();
  }

  getObject(id) {
    return this.allObjects.get(id);
  }  

  addObject(id, object, pending) {
    this.allObjects.set(id, object);
    if (object instanceof Sampler) {
      this.samplers.set(id, object);
    } else if (object instanceof Texture) {
      this.textures.set(id, object);
    } else if (object instanceof Buffer) {
      this.buffers.set(id, object);
    } else if (object instanceof BindGroup) {
      this.bindGroups.set(id, object);
    } else if (object instanceof BindGroupLayout) {
      this.bindGroupLayouts.set(id, object);
    } else if (object instanceof ShaderModule) {
      this.shaderModules.set(id, object);
    } else if (object instanceof RenderPipeline) {
      if (pending) {
        this.pendingRenderPipelines.set(id, object);
      } else {
        this.renderPipelines.set(id, object);
      }
    } else if (object instanceof ComputePipeline) {
      this.computePipelines.set(id, object);
    }

    this.onAddObject.emit(id, object, pending);
  }

  resolvePendingObject(id) {
    const object = this.allObjects.get(id);
    if (object instanceof RenderPipeline) {
      this.pendingRenderPipelines.delete(id);
      this.renderPipelines.set(id, object);

      this.onResolvePendingObject.emit(id, object);
    } else if (object instanceof ComputePipeline) {
      this.pendingComputePipelines.delete(id);
      this.computePipelines.set(id, object);
    }
  }

  deleteObject(id) {
    const object = this.allObjects.get(id);
    this.allObjects.delete(id);
    this.samplers.delete(id);
    this.textures.delete(id);
    this.buffers.delete(id);
    this.bindGroups.delete(id);
    this.bindGroupLayouts.delete(id);
    this.shaderModules.delete(id);
    this.renderPipelines.delete(id);
    this.computePipelines.delete(id);
    this.pendingRenderPipelines.delete(id);
    this.pendingComputePipelines.delete(id);

    this.onDeleteObject.emit(id, object);
  }
}

class InspectorWindow extends Window {
  constructor(database) {
    super();

    this.database = database
    this.classList.add("main-window");

    const self = this;

    const tabs = new TabWidget(this);

    const inspectorPanel = new Div();
    tabs.addTab("Inspector", inspectorPanel);

    const recorderPanel = new VSplit(null, { fixedPosition: 100 });
    tabs.addTab("Recorder", recorderPanel);

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

    const controlBar = new Div(inspectorPanel, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    this.inspectButton = new Button(controlBar, { label: "Start", callback: () => { 
      try {
        port.postMessage({ action: "initialize_inspector", tabId });
        self.reset();
      } catch (e) {}
    } });    

    this.inspectorGUI = new Div(inspectorPanel);

    this.reset();

    this.database.onEndFrame.addListener(this.updateFrameStats, this);
    this.database.onAddObject.addListener(this.addObject, this);
    this.database.onDeleteObject.addListener(this.deleteObject, this);
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

  reset() {
    const self = this;

    this.inspectorGUI.html = "";

    const split1 = new HSplit(this.inspectorGUI, { position: 0.2, style: "height: 100%;" });

    this.infoPanel = new Div(null, { class: "info-panel" });
    const infoTab = new TabWidget(split1);
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
    new Span(div, { text: "Pending Async Render Pipelines:", style: "color: #bbb;" });
    this.uiPendingRenderPipelinesStat = new Span(div, { text: "0", style: "margin-left: 5px;" });

    div = new Div(this.infoPanel, {style: "margin-right: 10px;"});
    new Span(div, { text: "Pending Async Compute Pipelines:", style: "color: #bbb;" });
    this.uiPendingComputePipelinesStat = new Span(div, { text: "0", style: "margin-left: 5px;" });


    const hSplit = new HSplit(split1, { position: 0.2, style: "height: 100%;" });

    const objectsTab = new TabWidget(hSplit);
    const objectsPanel = new Div(null, { style: "font-size: 11pt;"});
    objectsTab.addTab("Objects", objectsPanel);

    const inspectTab = new TabWidget(hSplit);
    this.inspectPanel = new Div(null, { style: "font-size: 14pt;"});
    inspectTab.addTab("Inspect", this.inspectPanel);

    this.objectsTree = new TreeWidget(objectsPanel, { style: "height: 100%; overflow-y: auto;", skipRoot: true });

    this.objectsTree.onItemSelected.addListener((data) => {
      const object = self.database.getObject(data.id);
      if (object) {
        self.inspectObject(data.id, object);
      }
    });

    const data = {
      id: '__Objects',
      node: null,
      content: 'Objects',
      children: [],
    };

    const adaptersData = {
      id: '__Adapters',
      content: "Adapters",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(adaptersData);

    const devicesData = {
      id: '__Devices',
      content: "Devices",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(devicesData);

    const renderPipelinesData = {
      id: '__RenderPipelines',
      content: "Render Pipelines",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(renderPipelinesData);

    const computePipelinesData = {
      id: '__ComputePipelines',
      content: "Compute Pipelines",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(computePipelinesData);

    const shaderModulesData = {
      id: '__ShaderModules',
      content: "Shader Modules",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(shaderModulesData);

    const buffersData = {
      id: '__Buffers',
      content: "Buffers",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(buffersData);

    const texturesData = {
      id: '__Textures',
      content: "Textures",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(texturesData);

    const samplersData = {
      id: '__Samplers',
      content: "Samplers",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(samplersData);

    const bindGroupsData = {
      id: '__BindGroups',
      content: "BindGroups",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(bindGroupsData);

    const bindGroupLayoutsData = {
      id: '__BindGroupLayouts',
      content: "BindGroupLayouts",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(bindGroupLayoutsData);

    const pendingAsyncRenderPipelinesData = {
      id: '__PendingAsyncRenderPipelines',
      content: "Pending Async Render Pipelines",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(pendingAsyncRenderPipelinesData);

    const pendingAsyncComputePipelinesData = {
      id: '__PendingAsyncComputePipelines',
      content: "Pending Async Compute Pipelines",
      children: [],
      collapsed: true,
      alwaysShowExpandButton: true
    };
    data.children.push(pendingAsyncComputePipelinesData);

    this.objectsTree.setData(data);
  }

  updateFrameStats() {
    this.uiFrameTime.text = `${this.database.frameTime.toFixed(2)}ms`;
    this.uiFrameRenderPasses.text =
      this.database.renderPassCount.toLocaleString("en-US");
  }

  deleteObject(id, object) {
    this.objectsTree.removeItem(id);
    this.updateObjectStat(object);
  }

  updateObjectStat(object) {
    if (object instanceof Buffer) {
      this.uiBuffersStat.text = `${this.database.buffers.size}`;
    } else if (object instanceof Sampler) {
      this.uiSamplersStat.text = `${this.database.samplers.size}`;
    } else if (object instanceof Texture) {
      this.uiTexturesStat.text = `${this.database.buffers.size}`;
    } else if (object instanceof ShaderModule) {
      this.uiShaderModulesStat.text = `${this.database.shaderModules.size}`;
    } else if (object instanceof BindGroupLayout) {
    } else if (object instanceof BindGroup) {
      this.uiBindGroupsStat.text = `${this.database.bindGroups.size}`;
    } else if (object instanceof RenderPipeline) {
      this.uiPendingRenderPipelinesStat.text = `${this.database.pendingRenderPipelines.size}`;
      this.uiRenderPipelinesStat.text = `${this.database.renderPipelines.size}`;
    } else if (object instanceof ComputePipeline) {
      this.uiPendingComputePipelinesStat.text = `${this.database.pendingComputePipelines.size}`;
      this.uiComputePipelinesStat.text = `${this.database.computePipelines.size}`;
    }
  }

  addObject(id, object, pending) {
    this.updateObjectStat(object);
    if (object instanceof Buffer) {
      const data = {
        id: id,
        content: `Buffer ${id}`,
        children: [],
      };
      this.objectsTree.insertItem(data, "__Buffers", -1);
    } else if (object instanceof Sampler) {
      const data = {
        id: id,
        content: `Sampler ${id}`,
        children: [],
      };
      this.objectsTree.insertItem(data, "__Samplers", -1);
    } else if (object instanceof Texture) {
      const data = {
        id: id,
        content: `Texture ${id}`,
        children: [],
      };
      this.objectsTree.insertItem(data, "__Textures", -1);
    } else if (object instanceof ShaderModule) {
      const data = {
        id: id,
        content: `ShaderModule ${id}`,
        children: [],
      };
      this.objectsTree.insertItem(data, "__ShaderModules", -1);
    } else if (object instanceof BindGroupLayout) {
      const data = {
        id: id,
        content: `BindGroupLayout ${id}`,
        children: [],
      };
    } else if (object instanceof BindGroup) {
      const data = {
        id: id,
        content: `BindGroup ${id}`,
        children: [],
      };
      this.objectsTree.insertItem(data, "__BindGroups", -1);
    } else if (object instanceof RenderPipeline) {
      const data = {
        id: id,
        content: `RenderPipeline ${id}`,
        children: [],
      };
      if (pending) {
        this.objectsTree.insertItem(data, "__PendingAsyncRenderPipelines", -1);
      } else {
        this.objectsTree.insertItem(data, "__RenderPipelines", -1);
      }
    } else if (object instanceof ComputePipeline) {
      const data = {
        id: id,
        content: `ComputePipeline ${id}`,
        children: [],
      };
      if (pending) {
        this.objectsTree.insertItem(data, "__PendingAsyncComputePipelines", -1);
      } else {
        this.objectsTree.insertItem(data, "__ComputePipelines", -1);
      }
    }
  }

  inspectObject(id, object) {
    this.inspectPanel.html = "";

    let div = new Div(this.inspectPanel);
    new Span(div, { text: object.constructor.name });

    div = new Div(this.inspectPanel);

    if (object instanceof ShaderModule) {
      const descriptor = new Span(div);
      const code = object.descriptor.code;
      descriptor.html = `<pre>${code}</pre>`
    } else {
      const descriptor = new Span(div);
      descriptor.html = `<pre>${JSON.stringify(object.descriptor, undefined, 4)}</pre>`;
    }
  }
}



async function main() {
  const objectDatabase = new ObjectDatabase();
  
  new InspectorWindow(objectDatabase);

  port.postMessage({action: "PanelLoaded", tabId});
}

main();
