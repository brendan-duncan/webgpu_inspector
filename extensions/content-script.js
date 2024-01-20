const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";

const port = chrome.runtime.connect({ name: "webgpu-inspector-content" });

function injectScriptNode(url, text) {
  // Inject the webgpu_debug script into the page
  const script = document.createElement("script");
  if (url) {
    script.src = url;
  }
  if (text) {
    script.text = text;
  }
  (document.head || document.documentElement).appendChild(script);
}

port.onMessage.addListener((message, sender, sendResponse) => {
  const action = message.action;
  if (!action) {
    return;
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

if (sessionStorage.getItem(webgpuInspectorLoadedKey)) {
  const url = chrome.runtime.getURL(`webgpu-inspector-panel.html`);
  injectScriptNode(chrome.runtime.getURL(`webgpu-inspector.js?extensionId=${chrome.runtime.id}&windowUrl=${encodeURIComponent(url)}`));
  sessionStorage.removeItem(webgpuInspectorLoadedKey);
} else if (sessionStorage.getItem(webgpuRecorderLoadedKey)) {
  const data = sessionStorage.getItem(webgpuRecorderLoadedKey).split("%");
  const url = `webgpu-recorder.js?filename=${encodeURIComponent(data[1])}&frames=${encodeURIComponent(data[0])}&removeUnusedResources=1`;
  injectScriptNode(chrome.runtime.getURL(url));
  sessionStorage.removeItem(webgpuRecorderLoadedKey);
}

port.postMessage({action: "PageLoaded"});
