import { ObjectDatabase } from "./src/object_database.js";
import { InspectorWindow } from "./src/inspector_window.js";
import { MessagePort } from "./src/message_port.js";

async function main() {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const port = new MessagePort("webgpu-inspector-panel", tabId);
  const objectDatabase = new ObjectDatabase(port);
  
  const inspector = new InspectorWindow(objectDatabase, port);
  await inspector.initialize();

  port.postMessage({action: "PanelLoaded"});
}

main();
