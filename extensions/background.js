let enabled = false;

chrome.action.onClicked.addListener(function(tab) {
    enabled = !enabled;
    chrome.action.setIcon({path: enabled ? "webgpu_inspector_on-38.png" : "webgpu_inspector_off-38.png"});

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        chrome.tabs.sendMessage(tabs[0].id, {
            action: enabled ? "enable_webgpu_inspector" : "disable_webgpu_inspector"
        });
    });
});
