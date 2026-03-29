/**
 * The background script manages connections between the devtools panel and
 * the content scripts injected into web pages. It forwards messages between
 * these two contexts. The background script is persistent and runs as long
 * as the extension is active. It keeps a record of active connections from
 * tabs to their associated ports.
 * @module background
 */

/** Map of tabId to port name to port array */
const connections = new Map();

/**
 * Gets or creates a connection map for a given tab.
 * @param {number} tabId - The tab ID
 * @returns {Map} The port map for the tab
 */
function getOrCreateTabConnection(tabId) {
  if (!connections.has(tabId)) {
    connections.set(tabId, new Map());
  }
  return connections.get(tabId);
}

/**
 * Registers a port for a given tab and sets up disconnect handling.
 * @param {chrome.runtime.Port} port - The port to register
 * @param {number} tabId - The tab ID
 */
function registerPort(port, tabId) {
  const portMap = getOrCreateTabConnection(tabId);

  if (!portMap.has(port.name)) {
    portMap.set(port.name, []);
  }

  const ports = portMap.get(port.name);
  if (!ports.includes(port)) {
    ports.push(port);

    port.onDisconnect.addListener(() => {
      const idx = ports.indexOf(port);
      if (idx !== -1) {
        ports.splice(idx, 1);
      }
      if (ports.length === 0) {
        portMap.delete(port.name);
      }
      if (portMap.size === 0) {
        connections.delete(tabId);
      }
    });
  }
}

/**
 * Posts a message to multiple ports, catching any errors.
 * @param {chrome.runtime.Port[]} ports - Array of ports to message
 * @param {Object} message - The message to send
 */
function postMessageToPorts(ports, message) {
  ports.forEach((p) => {
    try {
      p.postMessage(message);
    } catch (e) {
      console.error(`[WebGPU Inspector] Failed to post message to port ${p.name}:`, e);
    }
  });
}

/**
 * Handles incoming connections and message routing between panel and page scripts.
 * @param {chrome.runtime.Port} port - The connected port
 */
chrome.runtime.onConnect.addListener((port) => {
  /** @type {Object[]} Queue of messages received before registration */
  const pendingMessages = [];
  /** @type {boolean} Whether the port has been registered */
  let registered = false;

  /**
   * Handles incoming messages, queuing them until registered.
   * @param {Object} message - The incoming message
   */
  port.onMessage.addListener((message) => {
    const tabId = message.tabId !== undefined ? message.tabId : (port.sender?.tab?.id ?? 0);

    if (!registered) {
      pendingMessages.push(message);
      registerPort(port, tabId);
      registered = true;

      while (pendingMessages.length > 0) {
        const pending = pendingMessages.shift();
        const pendingTabId = pending.tabId !== undefined ? pending.tabId : (port.sender?.tab?.id ?? 0);
        handleMessage(port, pendingTabId, pending);
      }
      return;
    }

    handleMessage(port, tabId, message);
  });

  /**
   * Routes a message to the appropriate destination ports.
   * @param {chrome.runtime.Port} port - The source port
   * @param {number} tabId - The tab ID
   * @param {Object} message - The message to route
   */
  function handleMessage(port, tabId, message) {
    const portMap = connections.get(tabId);
    if (!portMap) {
      console.error(`[WebGPU Inspector] No port map found for tab ${tabId}`);
      return;
    }

    if (port.name === "webgpu-inspector-panel" && portMap.has("webgpu-inspector-page")) {
      postMessageToPorts(portMap.get("webgpu-inspector-page"), message);
    }

    if (port.name === "webgpu-inspector-page" && portMap.has("webgpu-inspector-panel")) {
      postMessageToPorts(portMap.get("webgpu-inspector-panel"), message);
    }
  }
});
