/**
 * The content script runs in the context of the web page, can send and receive messages
 * to/from the extension background script, and can inject scripts into the web page.
 * We use this to inject the webgpu_inspector_loader.js script into the page context,
 * and register to listen to messages from the background script and forward them to the page,
 * as well as messages from the page to the background script.
 * @module content_script
 */

import { MessagePort } from "../utils/message_port.js";
import { Actions, PanelActions } from "../utils/actions.js";

const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

/** Reload delay in milliseconds */
const RELOAD_DELAY_MS = 50;

/**
 * Checks if the browser is Firefox.
 * @returns {boolean} True if running in Firefox
 */
function isFirefox() {
  return navigator.userAgent.toLowerCase().includes('firefox');
}

/**
 * Checks if the browser is Chrome-based (Chrome, Edge, etc.)
 * @returns {boolean} True if running in a Chromium-based browser
 */
function isChromium() {
  return navigator.userAgent.indexOf("Chrom") !== -1;
}

/**
 * Forwards a valid inspector message to the background script.
 * @param {Object} message - The message to forward
 */
function forwardToBackground(message) {
  if (!message.action || !Actions.values.has(message.action)) {
    return;
  }

  try {
    port.postMessage(message);
  } catch (e) {
    console.error("[WebGPU Inspector] Error sending message from page:", e);
  }
}

/**
 * Forwards a valid inspector/recorder message to the background script.
 * @param {CustomEvent} event - The event containing the message
 */
function handleMessageEvent(event) {
  const message = event.detail;
  if (typeof message !== 'object' || message === null) {
    return;
  }
  forwardToBackground(message);
}

/**
 * Injects a script element into the document.
 * @param {string} name - The id name for the script
 * @param {string} url - The URL of the script
 * @param {Object|null} attributes - Optional attributes to set on the script
 */
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

// Create a message port to communicate with the background script.
const port = new MessagePort("webgpu-inspector-page", 0, (message) => {
  let action = message.action;
  if (!action) {
    return;
  }

  // Handle connection handshake from panel
  if (action === Actions.PanelReady) {
    port.postMessage({ action: Actions.ConnectionAck });
    return;
  }

  if (action === PanelActions.RequestTexture || action === PanelActions.CompileShader || action === PanelActions.RevertShader) {
    const msg = isFirefox() ? cloneInto(message, document.defaultView) : message;
    window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: msg }));
    return;
  }

  if (action === PanelActions.InitializeRecorder) {
    sessionStorage.setItem(webgpuRecorderLoadedKey, `${message.frames}%${message.filename}%${message.download}`);
    setTimeout(function () {
      window.location.reload();
    }, RELOAD_DELAY_MS);
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
      const captureMsg = { __webgpuInspector: true, __webgpuInspectorPanel: true, action: PanelActions.Capture,
        data: messageString };
      const msg = isFirefox() ? cloneInto(captureMsg, document.defaultView) : captureMsg;
      window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: msg }))
    }
  }
  
  if (action === PanelActions.InitializeInspector) {
    sessionStorage.setItem(webgpuInspectorLoadedKey, inspectMessage);
    setTimeout(function () {
      window.location.reload();
    }, RELOAD_DELAY_MS);
  }
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    port.reset();
  }
});

// Listen for messages from the page and forward to background script
window.addEventListener("__WebGPUInspector", handleMessageEvent);
window.addEventListener("__WebGPURecorder", handleMessageEvent);

// Fallback for browsers which don't support the "world" property on content_scripts
if (!isChromium() && (navigator.userAgent.indexOf("Safari") !== -1 || isFirefox())) {
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

// Send PageReady message to the background script to signal content script is ready.
port.postMessage({ action: Actions.PageReady });
