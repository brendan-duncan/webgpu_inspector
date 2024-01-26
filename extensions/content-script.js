const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

class MessagePort {
  constructor() {
    const self = this;
    this.port = null;
    this._resetPort();
  }

  _resetPort() {
    const self = this;
    this.port = chrome.runtime.connect({ name: "webgpu-inspector-content" });
    this.port.onDisconnect.addListener(() => {
      self._resetPort();
    });

    // Listen for messages from the server background
    this.port.onMessage.addListener((message) => {
      let action = message.action;
      if (!action) {
        return;
      }

      if (action == "inspector_capture") {
        sessionStorage.setItem(webgpuInspectorCaptureFrameKey, "true");
        if (!inspectorInitialized) {
          action = "initialize_inspector";
        }
      }

      if (action == "initialize_inspector") {
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
  }

  postMessage(message) {
    this.port.postMessage(message);
  }
}

let port = new MessagePort();

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

function injectScriptNode(url) {
  const script = document.createElement("script");
  script.type = "module";
  script.src = url;
  (document.head || document.documentElement).appendChild(script);
  script.parentNode.removeChild(script);
}


if (sessionStorage.getItem(webgpuInspectorLoadedKey)) {
  injectScriptNode(chrome.runtime.getURL(`webgpu-inspector.js`));
  sessionStorage.removeItem(webgpuInspectorLoadedKey);
  inspectorInitialized = true;
} else if (sessionStorage.getItem(webgpuRecorderLoadedKey)) {
  const data = sessionStorage.getItem(webgpuRecorderLoadedKey).split("%");
  const url = `webgpu-recorder.js?filename=${encodeURIComponent(data[1])}&frames=${encodeURIComponent(data[0])}&removeUnusedResources=1&messageRecording=1`;
  injectScriptNode(chrome.runtime.getURL(url));
  sessionStorage.removeItem(webgpuRecorderLoadedKey);
}

port.postMessage({action: "PageLoaded"});
