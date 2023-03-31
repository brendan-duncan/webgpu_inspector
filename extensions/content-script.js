// Inject the webgpu_debug script into the page
const script = document.createElement('script');
script.src = chrome.runtime.getURL('webgpu_inspector.js');
(document.head || document.documentElement).appendChild(script);

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action == "enable_webgpu_inspector") {
        window.postMessage({action: "enable_webgpu_inspector"}, "*");
    } else if (request.action == "disable_webgpu_inspector") {
        window.postMessage({action: "disable_webgpu_inspector"}, "*");
    }
});
