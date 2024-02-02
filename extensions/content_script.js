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

  const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
  const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
  const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

  const port = new MessagePort("webgpu-inspector-content", 0, (message) => {
    let action = message.action;
    if (!action) {
      return;
    }

    if (action == "inspector_capture") {
      sessionStorage.setItem(webgpuInspectorCaptureFrameKey, "true");
      if (!inspectorInitialized) {
        action = "initialize_inspector";
      }
    } else if (action == "inspect_request_texture") {
      window.postMessage(message, "*");
    } else if (action == "initialize_inspector") {
      sessionStorage.setItem(webgpuInspectorLoadedKey, "true");
      setTimeout(function () {
        window.location.reload();
      }, 50);
    } else if (action == "initialize_recorder") {
      sessionStorage.setItem(webgpuRecorderLoadedKey, `${message.frames}%${message.filename}`);
      setTimeout(function () {
        window.location.reload();
      }, 50);
    }
  });

  let inspectorInitialized = false;

  // Listen for messages from the page
  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    const message = event.data;
    if (typeof message !== 'object' || message === null) {
      return;
    }
    try {
      port.postMessage(message);
    } catch (e) {
      console.log("#### error:", e);
    }
  });

  function injectScriptNode(name, url, attributes) {
    const script = document.createElement("script");
    script.id = name;
    //script.type = "module";
    script.src = url;

    if (attributes) {
      for (const key in attributes) {
        script.setAttribute(key, attributes[key]);
      }
    }

    (document.head || document.documentElement).appendChild(script);
  }


  if (sessionStorage.getItem(webgpuInspectorLoadedKey)) {
    injectScriptNode("__webgpu_inspector", chrome.runtime.getURL("webgpu_inspector.js"));
    sessionStorage.removeItem(webgpuInspectorLoadedKey);
    inspectorInitialized = true;
  } else if (sessionStorage.getItem(webgpuRecorderLoadedKey)) {
    const data = sessionStorage.getItem(webgpuRecorderLoadedKey).split("%");
    injectScriptNode("__webgpu_recorder", chrome.runtime.getURL("webgpu_recorder.js"), {
      filename: data[1],
      frames: data[0],
      removeUnusedResources: 1,
      messageRecording: 1
    });
    sessionStorage.removeItem(webgpuRecorderLoadedKey);
  }

  port.postMessage({action: "PageLoaded"});

})();
