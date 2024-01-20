async function main() {
  const port = chrome.runtime.connect({ name: "webgpu-inspector-panel" });
  const tabId = chrome.devtools.inspectedWindow.tabId;

  const recordForm = document.getElementById("record");
  recordForm.addEventListener("submit", () => {
    const frames = document.getElementById("record_frames").value;
    const filename = document.getElementById("record_filename").value;
    port.postMessage({ action: "initialize_recorder", frames, filename, tabId });
  });

  const inspectForm = document.getElementById("inspect");
  inspectForm.addEventListener("submit", () => {
    try {
      port.postMessage({ action: "initialize_inspector", tabId });
    } catch (e) {
      console.error("@@@@ EXCEPTION", e);
    }
  });

  port.onMessage.addListener((message) => {
    if (message.action == "inspect_add_object") {
    }
  });

  port.postMessage({action: "PanelLoaded", tabId});
}

main();
