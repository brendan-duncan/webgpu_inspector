let activeTabs = new Set();

async function sendMessage(message) {
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
        chrome.tabs.sendMessage(tab.id, message);
    }
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'openSidePanel',
        title: 'Open side panel',
        contexts: ['all']
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'openSidePanel') {
        // This will open the panel in all the pages on the current window.
        chrome.sidePanel.open({ windowId: tab.windowId });
    }
});

chrome.runtime.onMessage.addListener((message, sender) => {
    // The callback for runtime.onMessage must return falsy if we're not sending a response
    (async () => {
        if (message.action == "inspect") {
            sendMessage({ action: "initialize_inspector" });
        } else if (message.action == "record") {
            sendMessage({ action: "initialize_recorder", filename: message.filename, frames: message.frames });
        } else if (message.type === 'open_side_panel') {
            await chrome.sidePanel.open({ tabId: sender.tab.id });
            await chrome.sidePanel.setOptions({
                tabId: sender.tab.id,
                path: 'sidepanel.html',
                enabled: true
            });
        }
    })();
});

chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
