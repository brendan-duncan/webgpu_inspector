export class MessagePort {
  constructor(name, tabId, listener) {
    this.name = name;
    this.tabId = tabId ?? 0;
    this.listeners = [];
    if (listener) {
      this.listeners.push(listener);
    }
    this._port = null;
    this._messageQueue = [];
    this._isConnected = false;
    this._isConnecting = false;
    this.reset();
  }

  reset() {
    console.log(`[WebGPU Inspector] MessagePort ${this.name} resetting connection`);

    const self = this;
    this._isConnected = false;
    this._isConnecting = true;

    try {
      this._port = chrome.runtime.connect({ name: this.name });

      this._port.onDisconnect.addListener(() => {
        console.warn(`[WebGPU Inspector] MessagePort ${self.name} disconnected`);
        self._isConnected = false;
        self._isConnecting = false;

        // Attempt to reconnect after a short delay
        setTimeout(() => {
          self.reset();
        }, 100);
      });

      this._port.onMessage.addListener((message) => {
        // Handle connection handshake acknowledgment
        if (message.action === "ConnectionAck") {
          self._handleConnectionAck();
          return;
        }

        for (const listener of self.listeners) {
          try {
            listener(message);
          } catch (e) {
            console.error(`[WebGPU Inspector] Error in message listener for port ${self.name}:`, e);
          }
        }
      });

      // Mark as connected immediately for now
      // Will be updated to wait for handshake in next step
      this._isConnecting = false;
      this._isConnected = true;
      this._flushMessageQueue();

      console.log(`[WebGPU Inspector] MessagePort ${this.name} connected`);
    } catch (e) {
      console.error(`[WebGPU Inspector] Failed to connect MessagePort ${this.name}:`, e);
      this._isConnecting = false;
      this._isConnected = false;

      // Retry connection after delay
      setTimeout(() => {
        self.reset();
      }, 1000);
    }
  }

  _handleConnectionAck() {
    console.log(`[WebGPU Inspector] MessagePort ${this.name} received connection acknowledgment`);
    this._isConnecting = false;
    this._isConnected = true;
    this._flushMessageQueue();
  }

  _flushMessageQueue() {
    if (!this._isConnected || this._messageQueue.length === 0) {
      return;
    }

    console.log(`[WebGPU Inspector] Flushing ${this._messageQueue.length} queued messages for port ${this.name}`);

    const queue = this._messageQueue.slice();
    this._messageQueue = [];

    for (const message of queue) {
      this._sendMessage(message);
    }
  }

  _sendMessage(message) {
    try {
      this._port.postMessage(message);
    } catch (e) {
      console.error(`[WebGPU Inspector] Failed to send message on port ${this.name}:`, e);
      // Queue the message and reset connection
      this._messageQueue.push(message);
      this._isConnected = false;
      this.reset();
    }
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  postMessage(message) {
    message.__webgpuInspector = true;
    if (this.tabId) {
      message.tabId = this.tabId;
    }

    // If not connected yet, queue the message
    if (!this._isConnected) {
      console.log(`[WebGPU Inspector] Queuing message (port ${this.name} not connected yet)`);
      this._messageQueue.push(message);
      return;
    }

    this._sendMessage(message);
  }
}
