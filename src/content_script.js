import { MessagePort } from "./utils/message_port.js";
import { Actions, PanelActions } from "./utils/actions.js";

const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

const port = new MessagePort("webgpu-inspector-page", 0, (message) => {
  let action = message.action;
  if (!action) {
    return;
  }

  if (action === PanelActions.Capture) {
    const messageString = JSON.stringify(message);
    sessionStorage.setItem(webgpuInspectorCaptureFrameKey, messageString);
    if (!inspectorInitialized) {
      action = PanelActions.InitializeInspector;
    }
  }
  
  if (action === PanelActions.RequestTexture || action === PanelActions.CompileShader) {
    window.postMessage(message, "*");
  }
  
  if (action === PanelActions.InitializeInspector) {
    sessionStorage.setItem(webgpuInspectorLoadedKey, "true");
    setTimeout(function () {
      window.location.reload();
    }, 50);
  }
  
  if (action === PanelActions.InitializeRecorder) {
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

  const action = message.action;

  if (!Actions.values.has(action)) {
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
