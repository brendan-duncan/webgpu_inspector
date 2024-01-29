import { ObjectDatabase } from "./src/object_database.js";
import { InspectorWindow } from "./src/inspector_window.js";

async function main() {
  const port = chrome.runtime.connect({ name: "webgpu-inspector-panel" });
  const tabId = chrome.devtools.inspectedWindow.tabId;

  const objectDatabase = new ObjectDatabase(port);
  
  const inspector = new InspectorWindow(objectDatabase, port, tabId);
  await inspector.initialize();

  port.postMessage({action: "PanelLoaded", tabId});
}

main();
