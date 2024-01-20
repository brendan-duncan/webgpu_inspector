const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";

const port = chrome.runtime.connect({ name: "webgpu-inspector-content" });

function injectScriptNode(url) {
  const script = document.createElement("script");
  script.src = url;
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



window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }
  const message = event.data;
  if (typeof message !== 'object' || message === null) {
    return;
  }
  console.log(message.source);

  port.postMessage(message);
});



if (sessionStorage.getItem(webgpuInspectorLoadedKey)) {
  injectScriptNode(chrome.runtime.getURL(`webgpu-inspector.js`));
  sessionStorage.removeItem(webgpuInspectorLoadedKey);
} else if (sessionStorage.getItem(webgpuRecorderLoadedKey)) {
  const data = sessionStorage.getItem(webgpuRecorderLoadedKey).split("%");
  const url = `webgpu-recorder.js?filename=${encodeURIComponent(data[1])}&frames=${encodeURIComponent(data[0])}&removeUnusedResources=1`;
  injectScriptNode(chrome.runtime.getURL(url));
  sessionStorage.removeItem(webgpuRecorderLoadedKey);
}

port.postMessage({action: "PageLoaded"});
