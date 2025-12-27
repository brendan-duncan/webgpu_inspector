const connections = new Map();

// Helper function to get or create tab connection map
function getOrCreateTabConnection(tabId) {
  if (!connections.has(tabId)) {
    connections.set(tabId, new Map());
  }
  return connections.get(tabId);
}

// Helper function to register a port
function registerPort(port, tabId) {
  const portMap = getOrCreateTabConnection(tabId);

  // Can be multiple content scripts per tab
  // for example if a web page includes iframe.
  // So manage ports as an array.
  if (!portMap.has(port.name)) {
    portMap.set(port.name, []);
  }

  const ports = portMap.get(port.name);
  if (!ports.includes(port)) {
    ports.push(port);

    port.onDisconnect.addListener(() => {
      //console.log(`[WebGPU Inspector] Port disconnected: ${port.name} (tab ${tabId})`);
      if (ports.includes(port)) {
        ports.splice(ports.indexOf(port), 1);
      }
      if (ports.length === 0) {
        portMap.delete(port.name);
      }
      if (portMap.size === 0) {
        connections.delete(tabId);
      }
    });
    
    //console.log(`[WebGPU Inspector] Port registered: ${port.name} (tab ${tabId})`);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  //console.log(`[WebGPU Inspector] Port connecting: ${port.name}`);

  // Register the port immediately on connect, before any messages
  // This is done in the first onMessage handler because we need the tabId
  let registered = false;

  port.onMessage.addListener((message, port) => {
    // Get tabId from message or port sender
    const tabId = message.tabId !== undefined ? message.tabId : (port.sender?.tab?.id ?? 0);

    // Register port on first message if not already registered
    if (!registered) {
      registerPort(port, tabId);
      registered = true;
    }

    const portMap = connections.get(tabId);
    if (!portMap) {
      console.error(`[WebGPU Inspector] No port map found for tab ${tabId}`);
      return;
    }

    const postMessageToPorts = (ports, message) => {
      ports.forEach((p) => {
        try {
          p.postMessage(message);
        } catch (e) {
          console.error(`[WebGPU Inspector] Failed to post message to port ${p.name}:`, e);
        }
      });
    };

    // transfer message between panel and contentScripts of the same tab
    if (port.name === "webgpu-inspector-panel" && portMap.has("webgpu-inspector-page")) {
      postMessageToPorts(portMap.get("webgpu-inspector-page"), message);
    }

    if (port.name === "webgpu-inspector-page" && portMap.has("webgpu-inspector-panel")) {
      postMessageToPorts(portMap.get("webgpu-inspector-panel"), message);
    }
  });
});
