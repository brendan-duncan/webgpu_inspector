import { MessagePort } from "../utils/message_port.js";
import { Actions, PanelActions } from "../utils/actions.js";

const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

const port = new MessagePort("webgpu-inspector-page", 0, (message) => {
  let action = message.action;
  if (!action) {
    return;
  }

  if (action === PanelActions.RequestTexture || action === PanelActions.CompileShader || action === PanelActions.RevertShader) {
    window.postMessage(message, "*");
    return;
  }

  if (action === PanelActions.InitializeRecorder) {
    sessionStorage.setItem(webgpuRecorderLoadedKey, `${message.frames}%${message.filename}`);
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
    if (!inspectorInitialized || message.frame >= 0) {
      action = PanelActions.InitializeInspector;
      inspectMessage = messageString;
    } else {
      sessionStorage.setItem(webgpuInspectorCaptureFrameKey, messageString);
    }
  }
  
  if (action === PanelActions.InitializeInspector) {
    sessionStorage.setItem(webgpuInspectorLoadedKey, inspectMessage);
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

const inspectMessage = sessionStorage.getItem(webgpuInspectorLoadedKey);
if (inspectMessage) {
  sessionStorage.removeItem(webgpuInspectorLoadedKey);

  if (inspectMessage !== "true") {
    sessionStorage.setItem(webgpuInspectorCaptureFrameKey, inspectMessage);
  }

  injectScriptNode("__webgpu_inspector", chrome.runtime.getURL("webgpu_inspector.js"));
  
  inspectorInitialized = true;
}

const recordMessage = sessionStorage.getItem(webgpuRecorderLoadedKey);
if (recordMessage) {
  sessionStorage.removeItem(webgpuRecorderLoadedKey);
  const data = recordMessage.split("%");
  injectScriptNode("__webgpu_recorder", chrome.runtime.getURL("webgpu_recorder.js"), {
    filename: data[1],
    frames: data[0],
    removeUnusedResources: 1,
    messageRecording: 1
  });
  
}

port.postMessage({action: "PageLoaded"});
