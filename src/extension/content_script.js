import { MessagePort } from "../utils/message_port.js";
import { Actions, PanelActions } from "../utils/actions.js";

const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";
const isRunningInFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;

const port = new MessagePort("webgpu-inspector-page", 0, (message) => {
  let action = message.action;
  if (!action) {
    return;
  }

  if (action === PanelActions.RequestTexture || action === PanelActions.CompileShader || action === PanelActions.RevertShader) {
    const msg = isRunningInFirefox ? cloneInto(message, document.defaultView) : message;
    window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: msg }));
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
      const msg = isRunningInFirefox ? cloneInto(message, document.defaultView) : message;
      window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: msg }))
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
if (navigator.userAgent.indexOf("Chrom") === -1 &&
  (navigator.userAgent.indexOf("Safari") !== -1 || navigator.userAgent.indexOf("Firefox") !== -1)) {
  if (sessionStorage.getItem(webgpuInspectorLoadedKey)) {
    injectScriptNode("__webgpu_inspector", chrome.runtime.getURL("webgpu_inspector_loader.js"));
  }

  const recordMessage = sessionStorage.getItem(webgpuRecorderLoadedKey);
  if (recordMessage) {
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
