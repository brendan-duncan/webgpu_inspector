const uniqueId = new Date().getTime() + Math.abs(Math.random() * 1000000);
const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";

function injectScriptNode(url) {
  // Inject the webgpu_debug script into the page
  const script = document.createElement("script");
  script.src = url;
  (document.head || document.documentElement).appendChild(script);
}

function sendMessage(message, cb) {
  message["uniqueId"] = uniqueId;
  chrome.runtime.sendMessage(message, function (response) {
    if (cb) {
      cb(response);
    }
  });
}

function listenForMessage(callback) {
  chrome.runtime.onMessage.addListener(callback);
}

listenForMessage(function (request, sender, sendResponse) {
  const action = request.action;
  if (!action) {
    return;
  }

  if (action == "initialize") {
    if (!sessionStorage.getItem(webgpuInspectorLoadedKey)) {
      sessionStorage.setItem(webgpuInspectorLoadedKey, "true");
      setTimeout(function () {
        window.location.reload();
      }, 50);
      return;
    }
  } else if (action == "disable") {
    sessionStorage.removeItem(webgpuInspectorLoadedKey);
    setTimeout(function () {
      window.location.reload();
    }, 50);
    return;
  }
});

if (sessionStorage.getItem(webgpuInspectorLoadedKey)) {
  injectScriptNode(chrome.runtime.getURL("webgpu_inspector.js"));
  sendMessage({ initialized: 1 });
} else {
  sendMessage({ initialized: 0 });
}
