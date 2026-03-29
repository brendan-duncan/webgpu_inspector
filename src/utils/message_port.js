/**
 * Manages a Chrome extension message port connection with automatic reconnection
 * and message queuing capabilities.
 */
export class MessagePort {
  /**
   * @param {string} name The name of the port (used for identification)
   * @param {number?} tabId Optional tab ID to associate with messages
   * @param {function?} listener Optional message listener to add immediately
   */
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

  /**
   * Establishes a connection to the Chrome extension runtime.
   * Sets up disconnect and message listeners, and attempts reconnection on failure.
   */
  reset() {
    const self = this;
    this._isConnected = false;
    this._isConnecting = true;

    try {
      this._port = chrome.runtime.connect({ name: this.name });

      this._port.onDisconnect.addListener(() => {
        self._isConnected = false;
        self._isConnecting = false;

        setTimeout(() => {
          self.reset();
        }, 100);
      });

      this._port.onMessage.addListener((message) => {
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

      this._isConnecting = false;
      this._isConnected = true;
      this._flushMessageQueue();
    } catch (e) {
      this._isConnecting = false;
      this._isConnected = false;

      setTimeout(() => {
        self.reset();
      }, 1000);
    }
  }

  /**
   * Handles the connection acknowledgment message from the runtime.
   * @private
   */
  _handleConnectionAck() {
    this._isConnecting = false;
    this._isConnected = true;
    this._flushMessageQueue();
  }

  /**
   * Sends all queued messages that were pending during disconnection.
   * @private
   */
  _flushMessageQueue() {
    if (!this._isConnected || this._messageQueue.length === 0) {
      return;
    }

    const queue = this._messageQueue.slice();
    this._messageQueue = [];

    for (const message of queue) {
      this._sendMessage(message);
    }
  }

  /**
   * Sends a single message through the port.
   * @param {Object} message The message to send
   * @private
   */
  _sendMessage(message) {
    try {
      this._port.postMessage(message);
    } catch (e) {
      console.error(`[WebGPU Inspector] Failed to send message on port ${this.name}:`, e);
      this._messageQueue.push(message);
      this._isConnected = false;
      this.reset();
    }
  }

  /**
   * Adds a message listener to receive messages from this port.
   * @param {function} listener The listener function to add
   */
  addListener(listener) {
    this.listeners.push(listener);
  }

  /**
   * Sends a message through the port. Messages are queued if not yet connected.
   * @param {Object} message The message to send
   */
  postMessage(message) {
    message.__webgpuInspector = true;
    if (this.tabId) {
      message.tabId = this.tabId;
    }

    if (!this._isConnected) {
      this._messageQueue.push(message);
      return;
    }

    this._sendMessage(message);
  }
}
