const connections = new Map();

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((message, port) => {
    const tabId = message.tabId !== undefined ? message.tabId : port.sender.tab.id;
    if (!connections.has(tabId)) {
      connections.set(tabId, new Map());
    }

    const portMap = connections.get(tabId);

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
    }

    const postMessageToPorts = (ports, message) => {
      ports.forEach((port) => {
        port.postMessage(message);
      });
    };

    // transfer message between panel and contentScripts of the same tab
    if (port.name === "webgpu-inspector-panel" && portMap.has("webgpu-inspector-content")) {
      postMessageToPorts(portMap.get("webgpu-inspector-content"), message);
    }

    if (port.name === "webgpu-inspector-content" && portMap.has("webgpu-inspector-panel")) {
      postMessageToPorts(portMap.get("webgpu-inspector-panel"), message);
    }
  });
});
