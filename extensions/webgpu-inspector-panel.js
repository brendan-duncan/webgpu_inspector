import { ObjectDatabase } from "./src/object_database.js";
import { InspectorWindow } from "./src/inspector_window.js";

function main() {
  const port = chrome.runtime.connect({ name: "webgpu-inspector-panel" });
  const tabId = chrome.devtools.inspectedWindow.tabId;

  const objectDatabase = new ObjectDatabase(port);
  
  new InspectorWindow(objectDatabase, port, tabId);

  port.postMessage({action: "PanelLoaded", tabId});
}

main();
