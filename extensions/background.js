function sendMessage(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, message);
  });
}

function listenForMessage(callback) {
  chrome.runtime.onMessage.addListener(callback);
}

let activeTabs = new Set();

chrome.action.onClicked.addListener(function (tab) {
  if (activeTabs.has(tab.id)) {
    sendMessage({ action: "disable" });
    chrome.action.setIcon({ path: "webgpu_inspector_off-38.png" });
  } else {
    sendMessage({ action: "initialize" });
  }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  let activeTabId = activeInfo.tabId;
  if (activeTabs.has(activeTabId)) {
    chrome.action.setIcon({ path: "webgpu_inspector_on-38.png" });
  } else {
    chrome.action.setIcon({ path: "webgpu_inspector_off-38.png" });
  }
});

listenForMessage(function (request, sender, sendResponse) {
  if (request.initialized === 0) {
    activeTabs.delete(sender.tab.id);
    chrome.action.setIcon({ path: "webgpu_inspector_off-38.png" });
  } else if (request.initialized === 1) {
    activeTabs.add(sender.tab.id);
    chrome.action.setIcon({ path: "webgpu_inspector_on-38.png" });
  }
});
