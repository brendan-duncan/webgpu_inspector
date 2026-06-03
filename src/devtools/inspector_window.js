import { Actions } from "../utils/actions.js";
import { ObjectDatabase } from "./object_database.js";
import { MessagePort } from "../utils/message_port.js";
import { Div } from "./widget/div.js";
import { Widget } from "./widget/widget.js";
import { TabWidget } from "./widget/tab_widget.js";
import { TextureUtils } from "../utils/texture_utils.js";
import { Window } from "./widget/window.js";
import { CapturePanel } from "./capture_panel.js";
import { RecorderPanel } from "./recorder_panel.js";
import { InspectPanel } from "./inspect_panel.js";
import { Signal } from "../utils/signal.js";
import { decodeBase64 } from "../utils/base64.js";
import { TextureFormatInfo } from "../utils/texture_format_info.js";
import { Texture } from "./gpu_objects/texture.js";
import { GPUObjectRef } from "./gpu_objects/gpu_object_ref.js";
import { takeCaptureHandoff } from "../utils/capture_handoff.js";

export class InspectorWindow extends Window {
  constructor() {
    super();

    // chrome.devtools is only available when this page is loaded as a DevTools
    // panel. When opened standalone (e.g. via "Open in New Window" from a
    // capture tab), it is undefined; the panel still works as a capture viewer.
    const tabId = (typeof chrome !== "undefined" && chrome.devtools?.inspectedWindow)
      ? chrome.devtools.inspectedWindow.tabId
      : 0;
    this.isStandalone = !tabId;
    // readyAction posts PanelReady on every (re)connect, so a service-worker
    // restart re-registers this port in the background without requiring the
    // user to trigger a message first.
    this.port = new MessagePort("webgpu-inspector-panel", tabId, null, Actions.PanelReady);
    this.database = new ObjectDatabase(this.port);
    this.classList.add("main-window");
    this._selectedObject = null;
    this._inspectedObject = null;

    this.adapter = null;
    this.device = null;

    this.onTextureLoaded = new Signal();
    this.onTextureDataChunkLoaded = new Signal();

    this._tabs = new TabWidget(this);

    const inspectorPanel = new Div(null, { class: "inspector_panel" });
    this._tabs.addTab("🔍 Inspect", inspectorPanel);
    this._inspectPanel = new InspectPanel(this, inspectorPanel);

    const capturePanel = new Div(null, { class: "capture_panel" });
    this._tabs.addTab("🖼️ Capture", capturePanel);
    this._capturePanel = new CapturePanel(this, capturePanel);

    const recorderPanel = new Div(null, { class: "recorder_panel" });
    this._tabs.addTab("🔵 Record", recorderPanel);
    this._recorderPanel = new RecorderPanel(this, recorderPanel);

    const version = "__buildVersion";
    new Widget("a", this._tabs.headerElement, { text: `WebGPU Inspector v${version}`,
      href: "https://github.com/brendan-duncan/webgpu_inspector/blob/main/README.md",
      target: "_blank",
      style: "color: rgb(127 181 205); text-decoration: none; padding-top: 5px; font-size: 10pt; float: right; margin-right: 10px;" 
    });

    const self = this;
    this.port.addListener((message) => {
      switch (message.action) {
        case Actions.CaptureTextureData: {
          const id = message.id;
          const passId = message.passId;
          const mipLevel = message.mipLevel ?? 0;
          const offset = message.offset;
          const size = message.size;
          const index = message.index;
          const count = message.count;
          const chunk = message.chunk;
          self._captureTextureData(id, passId, mipLevel, offset, size, index, count, chunk);
          break;
        }
      }
    });

    this.initialize();
    this._loadPendingCapture();
  }

  async _loadPendingCapture() {
    try {
      const hash = (typeof window !== "undefined" && window.location.hash) || "";
      const match = /pendingCapture=([^&]+)/.exec(hash);
      if (!match) {
        return;
      }
      const key = decodeURIComponent(match[1]);
      const text = await takeCaptureHandoff(key);
      if (!text) {
        return;
      }
      // Activate the Capture tab and feed the JSON through the existing
      // import flow as if the user had loaded it from disk.
      this._tabs.activeTab = 1;
      const label = key.replace(/^webgpu_inspector_pending_capture_/, "") || "imported";
      this._capturePanel._importCaptureJson(text, label);
    } catch (e) {
      console.error("Failed to load pending capture:", e);
    }
  }

  async initialize() {
    // PanelReady is sent automatically by MessagePort on every (re)connect.

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

  inspectObject(object) {
    if (!object) {
      return;
    }
    this._tabs.activeTab = 0;
    this._inspectPanel.inspectObject(object);
  }

  _captureTextureData(id, passId, mipLevel, offset, size, index, count, chunk) {
    const object = this.database.getObject(id);
    if (!object || !(object instanceof Texture)) {
      return;
    }

    if (object.loadedImageDataChunks[mipLevel] === undefined) {
      object.loadedImageDataChunks[mipLevel] = [];
    }

    if (object.loadedImageDataChunks[mipLevel].length != count) {
      object.loadedImageDataChunks[mipLevel].length = count;
      object.isImageDataLoaded[mipLevel] = false;
    }

    if (!(object.imageData[mipLevel] instanceof Uint8Array) || (object.imageData[mipLevel].length != size)) {
      object.imageData[mipLevel] = new Uint8Array(size);
      object.dataLoadTime = 0;
      object._startTime = [];
    }

    object._startTime[index] = performance.now();

    let data;
    try {
      data = decodeBase64(chunk);
    } catch (e) {
      console.error("Error decoding texture chunk:", e);
      return;
    }

    const t1 = object._startTime[index];
    const t2 = performance.now();
    object.dataLoadTime += (t2 - t1);
    this.onTextureDataChunkLoaded.emit(id, passId, mipLevel, offset, size, index, count, chunk);
    object.loadedImageDataChunks[mipLevel][index] = 1;
    try {
      object.imageData[mipLevel].set(data, offset);
    } catch (e) {
      console.log("TEXTURE IMAGE DATA SET ERROR", id, passId, mipLevel, offset, data.length, object.imageData[mipLevel].length);
      object.loadedImageDataChunks[mipLevel].length = 0;
      object.isImageDataLoaded[mipLevel] = false;
    }

    let loaded = true;
    for (let i = 0; i < count; ++i) {
      if (!object.loadedImageDataChunks[mipLevel][i]) {
        loaded = false;
        break;
      }
    }
    object.isImageDataLoaded[mipLevel] = loaded;

    if (object.isImageDataLoaded[mipLevel]) {
      object.loadedImageDataChunks[mipLevel].length = 0;
      object.imageDataPending[mipLevel] = false;
      object._layerRanges = null;
      this._createTexture(object, passId, mipLevel);
    }
  }

  _createTexture(texture, passId, mipLevel) {
    if (!this.device) {
      return;
    }

    const usage = texture.descriptor.usage;
    const format = texture.descriptor.format;
    const sampleCount = texture.descriptor.sampleCount;
    const formatInfo = TextureFormatInfo[format];

    /*if (texture.gpuTexture) {
      texture.gpuTexture.removeReference();
    }*/

    const gpuFormat = formatInfo.isDepthStencil ? "r32float" : format;
    texture.descriptor.format = gpuFormat;
    texture.descriptor.usage = (usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    texture.descriptor.sampleCount = 1;

    const bytesPerRow = (texture.bytesPerRow) >> mipLevel;
    const rowsPerImage = (texture.height) >> mipLevel;

    if (!texture.gpuTexture) {
      const gpuTexture = this.device.createTexture(texture.descriptor);
      texture.gpuTexture = new GPUObjectRef(gpuTexture);
    }

    //const gpuTexture = this.device.createTexture(texture.descriptor);
    //texture.gpuTexture = new GPUObjectRef(gpuTexture);
    texture.descriptor.usage = usage;
    texture.descriptor.format = format;
    texture.descriptor.sampleCount = sampleCount;

    const size = texture.getMipSize(mipLevel);
   
    this.device.queue.writeTexture(
      {
        texture: texture.gpuTexture.object,
        mipLevel
      },
      texture.imageData[mipLevel],
      {
        offset: 0,
        bytesPerRow,
        rowsPerImage
      },
      size);

    this.onTextureLoaded.emit(texture, passId);
  }
}


async function main() {
  new InspectorWindow();
}

main();
