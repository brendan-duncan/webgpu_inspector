import { ObjectDatabase } from "./object_database.js";
import { MessagePort } from "../utils/message_port.js";
import { Div } from "./widget/div.js";
import { TabWidget } from "./widget/tab_widget.js";
import { TextureUtils } from "../utils/texture_utils.js";
import { Window } from "./widget/window.js";
import { CapturePanel } from "./capture_panel.js";
import { RecorderPanel } from "./recorder_panel.js";
import { InspectPanel } from "./inspect_panel.js";
import { Signal } from "../utils/signal.js";
import { decodeDataUrl } from "../utils/base64.js";
import { TextureFormatInfo } from "../utils/texture_format_info.js";
import {
  Texture
} from "./object_database.js";

export class InspectorWindow extends Window {
  constructor() {
    super();

    const tabId = chrome.devtools.inspectedWindow.tabId;
    this.port = new MessagePort("webgpu-inspector-panel", tabId);
    this.database = new ObjectDatabase(this.port);
    this.classList.add("main-window");
    this._selectedObject = null;
    this._inspectedObject = null;
    this.objectDatabase = new ObjectDatabase(this.port);

    this.adapter = null;
    this.device = null;

    this.onTextureLoaded = new Signal();

    this._tabs = new TabWidget(this);

    const inspectorPanel = new Div(null, { class: "inspector_panel" });
    this._tabs.addTab("Inspect", inspectorPanel);
    this._inspectPanel = new InspectPanel(this, inspectorPanel);

    const capturePanel = new Div(null, { class: "capture_panel" });
    this._tabs.addTab("Capture", capturePanel);
    this._capturePanel = new CapturePanel(this, capturePanel);

    const recorderPanel = new Div(null, { class: "recorder_panel" });
    this._tabs.addTab("Record", recorderPanel);
    this._recorderPanel = new RecorderPanel(this, recorderPanel);

    const self = this;
    this.port.addListener((message) => {
      switch (message.action) {
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

    this.initialize();
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

    this.port.postMessage({action: "PanelLoaded"});
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

    if (!(object.imageData instanceof Uint8Array) || (object.imageData.length != size)) {
      object.imageData = new Uint8Array(size);
    }

    decodeDataUrl(chunk).then((data) => {
      object.loadedImageDataChunks[index] = 1;
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
    });
  }

  _createTexture(texture, passId) {
    const usage = texture.descriptor.usage;
    const format = texture.descriptor.format;
    const formatInfo = TextureFormatInfo[format] ?? TextureFormatInfo["rgba8unorm"];

    // For depth textures we can't currently use writeTexture.
    // To load data into a depth texture, put the imageData into a storage buffer
    // then do a blit where the shader reads from the storage buffer and writes
    // to frag_depth. On the webgpu_inspector side, we should translate imageData
    // from depth24plus to depth32 so we can deal with floats and not weird depth24
    // data.

    // For now, we can't preview depth-stencil textures.
    if (formatInfo.isDepthStencil) {
      return;
    }

    const gpuFormat = formatInfo.depthOnlyFormat ?? format;
    texture.descriptor.format = gpuFormat;
    texture.descriptor.usage = (usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    texture.gpuTexture = this.window.device.createTexture(texture.descriptor);
    texture.descriptor.usage = usage;
    texture.descriptor.format = format;
    
    const width = texture.width;
    const texelByteSize = formatInfo.bytesPerBlock;
    const bytesPerRow = (width * texelByteSize + 255) & ~0xff;
    const rowsPerImage = texture.height;

    this.window.device.queue.writeTexture(
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

    this.onTextureLoaded.emit(texture, passId);
  }
}


async function main() {
  new InspectorWindow();
}

main();
