(function () {
  'use strict';

  class MessagePort {
    constructor(name, tabId, listener) {
      this.name = name;
      this.tabId = tabId ?? 0;
      this.listeners = [];
      if (listener) {
        this.listeners.push(listener);
      }
      this._port = null;
      this.reset();
    }

    reset() {
      const self = this;
      this._port = chrome.runtime.connect({ name: this.name });
      this._port.onDisconnect.addListener(() => {
        self.reset();
      });
      this._port.onMessage.addListener((message) => {
        for (const listener of self.listeners) {
          listener(message);
        }
      });
    }

    addListener(listener) {
      this.listeners.push(listener);
    }

    postMessage(message) {
      message.__webgpuInspector = true;
      if (this.tabId) {
        message.tabId = this.tabId;
      }
      try {
        this._port.postMessage(message);
      } catch (e) {
        this.reset();
      }
    }
  }

  const Actions = {
    CaptureBufferData: "webgpu_inspect_capture_buffer_data",
    CaptureBuffers: "webgpu_inspect_capture_buffers",
    DeleteObjects: "webgpu_inspect_delete_objects",
    ValidationError: "webgpu_inspect_validation_error",
    MemoryLeakWarning: "webgpu_inspect_memory_leak_warning",
    DeltaTime: "webgpu_inspect_delta_time",
    CaptureFrameResults: "webgpu_inspect_capture_frame_results",
    CaptureFrameCommands: "webgpu_inspect_capture_frame_commands",
    ObjectSetLabel: "webgpu_inspect_object_set_label",
    AddObject: "webgpu_inspect_add_object",
    ResolveAsyncObject: "webgpu_inspect_resolve_async_object",
    DeleteObject: "webgpu_inspect_delete_object",
    CaptureTextureFrames: "webgpu_inspect_capture_texture_frames",
    CaptureTextureData: "webgpu_inspect_capture_texture_data",
    CaptureBufferData: "webgpu_inspect_capture_buffer_data",

    Recording: "webgpu_record_recording",
    RecordingCommand: "webgpu_record_command",
    RecordingDataCount: "webgpu_record_data_count",
    RecordingData: "webgpu_record_data"
  };

  Actions.values = new Set(Object.values(Actions));

  const PanelActions = {
    RequestTexture: "webgpu_inspect_request_texture",
    CompileShader: "webgpu_inspect_compile_shader",
    RevertShader: "webgpu_inspect_revert_shader",
    Capture: "webgpu_inspector_capture",
    InitializeInspector: "webgpu_initialize_inspector",
    InitializeRecorder: "webgpu_initialize_recorder"
  };

  const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
  const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
  const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

  const port = new MessagePort("webgpu-inspector-page", 0, (message) => {
    let action = message.action;
    if (!action) {
      return;
    }

    if (action === PanelActions.RequestTexture || action === PanelActions.CompileShader || action === PanelActions.RevertShader) {
      window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: message }));
      return;
    }

    if (action === PanelActions.InitializeRecorder) {
      sessionStorage.setItem(webgpuRecorderLoadedKey, `${message.frames}%${message.filename}%${message.download}`);
      setTimeout(function () {
        window.location.reload();
      }, 50);
      return;
    }

    // If a capture is requested and either the inspector hasn't been initialized yet or the frame is not -1,
    // we need to initialize the inspector. If the frame is not -1, then a specific frame has been requested
    // to be captured. We need to put this information into the inspector initialization so that it doesn't
    // get lost in the reload.
    let inspectMessage = "true";
    if (action === PanelActions.Capture) {
      const messageString = JSON.stringify(message);
      if (message.frame >= 0) {
        action = PanelActions.InitializeInspector;
        inspectMessage = messageString;
      } else {
        sessionStorage.setItem(webgpuInspectorCaptureFrameKey, messageString);
        const message = { __webgpuInspector: true, __webgpuInspectorPanel: true, action: PanelActions.Capture,
          data: messageString };
        window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: message }));
      }
    }
    
    if (action === PanelActions.InitializeInspector) {
      sessionStorage.setItem(webgpuInspectorLoadedKey, inspectMessage);
      setTimeout(function () {
        window.location.reload();
      }, 50);
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      // The page is restored from BFCache, set up a new connection.
      port.reset();
    }
  });

  // Listen for messages from the page
  window.addEventListener("__WebGPUInspector", (event) => {
    const message = event.detail;
    if (typeof message !== 'object' || message === null) {
      return;
    }

    const action = message.action;

    if (!Actions.values.has(action)) {
      return;
    }

    try {
      port.postMessage(message);
    } catch (e) {
      //console.log("#### error:", e);
    }
  });

  window.addEventListener("__WebGPURecorder", (event) => {
    const message = event.detail;
    if (typeof message !== 'object' || message === null) {
      return;
    }

    const action = message.action;

    if (!Actions.values.has(action)) {
      return;
    }

    try {
      port.postMessage(message);
    } catch (e) {
      //console.log("#### error:", e);
    }
  });

  function injectScriptNode(name, url, attributes) {
    const script = document.createElement("script");
    script.id = name;
    script.src = url;

    if (attributes) {
      for (const key in attributes) {
        script.setAttribute(key, attributes[key]);
      }
    }

    (document.head || document.documentElement).appendChild(script);
  }

  // Fallback for browsers which don't support the "world" property on content_scripts
  if (
    navigator.userAgent.indexOf("Chrom") === -1 && (
      navigator.userAgent.indexOf("Safari") !== -1 || navigator.userAgent.indexOf("Firefox") !== -1
    )
  ) {
    if (sessionStorage.getItem(webgpuInspectorLoadedKey)) {
      console.log("[WebGPU Inspector] Fallback injection");

      injectScriptNode("__webgpu_inspector", chrome.runtime.getURL("webgpu_inspector_loader.js"));
    }

    const recordMessage = sessionStorage.getItem(webgpuRecorderLoadedKey);
    if (recordMessage) {
      sessionStorage.removeItem(webgpuRecorderLoadedKey);
      const data = recordMessage.split("%");
      injectScriptNode("__webgpu_recorder", chrome.runtime.getURL("webgpu_recorder_loader.js"), {
        filename: data[1],
        frames: data[0],
        download: data[2],
        removeUnusedResources: 1,
        messageRecording: 1
      });
    }
  }

  port.postMessage({action: "PageLoaded"});

})();
//# sourceMappingURL=content_script.js.map
