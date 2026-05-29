/**
 * Manages a Chrome extension message port connection with automatic reconnection
 * and message queuing capabilities.
 */
export class MessagePort {
  /**
   * @param {string} name The name of the port (used for identification)
   * @param {number?} tabId Optional tab ID to associate with messages
   * @param {function?} listener Optional message listener to add immediately
   * @param {string?} readyAction Optional action posted automatically on every
   *   successful (re)connect. Used so both ends re-announce themselves after a
   *   Manifest V3 service-worker restart, which registers each port in the
   *   background without waiting for user-driven traffic.
   */
  constructor(name, tabId, listener, readyAction) {
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
    this._readyAction = readyAction ?? null;
    // Transparent large-message chunking. Chrome caps a single port message at 64MiB; recordings
    // can produce larger ones (e.g. a big base64 buffer/texture payload). Oversized messages are
    // split into sub-limit chunks on send and reassembled on receive, invisibly to listeners.
    this._chunkSendId = 0;
    this._chunkRecv = new Map();
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
        const result = self._receiveChunk(message);
        if (result === undefined) {
          // A partial (or un-reassemblable) chunk — nothing to dispatch yet.
          return;
        }
        // null means "not a chunk, dispatch the message as-is"; otherwise it's the reassembled message.
        const msg = result === null ? message : result;
        for (const listener of self.listeners) {
          try {
            listener(msg);
          } catch (e) {
            console.error(`[WebGPU Inspector] Error in message listener for port ${self.name}:`, e);
          }
        }
      });

      this._isConnecting = false;
      this._isConnected = true;

      // Re-announce on every (re)connect so the background can register this port
      // even after a service-worker restart. Without this, a panel-port reconnect
      // would stay unregistered until the user did something that emitted a message.
      // Sent before flushing the queue so the registration happens first.
      if (this._readyAction) {
        this.postMessage({ action: this._readyAction });
      }

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
      // A too-large message would otherwise be requeued and retried forever (the port resets and
      // re-flushes the queue), spamming the console. Split it into chunks instead.
      const isSizeError = e && typeof e.message === "string" &&
        e.message.indexOf("maximum allowed size") !== -1;
      if (isSizeError && this._trySendChunked(message)) {
        return;
      }
      console.error(`[WebGPU Inspector] Failed to send message on port ${this.name}:`, e);
      this._messageQueue.push(message);
      this._isConnected = false;
      this.reset();
    }
  }

  /**
   * Splits an oversized message into sub-limit chunk messages and sends them. The receiving
   * MessagePort reassembles them in _receiveChunk before dispatching to listeners.
   * @param {Object} message The message that exceeded the port size limit.
   * @returns {boolean} True if the message was chunked and sent; false to fall back to requeue.
   * @private
   */
  _trySendChunked(message) {
    let serialized;
    try {
      serialized = JSON.stringify(message);
    } catch (e) {
      return false;
    }
    const chunkSize = MessagePort.chunkSize;
    const count = Math.ceil(serialized.length / chunkSize) || 1;
    const id = ++this._chunkSendId;
    try {
      for (let index = 0; index < count; ++index) {
        const payload = serialized.substring(index * chunkSize, (index + 1) * chunkSize);
        const chunkMsg = { __webgpuInspectorChunk: { id, index, count, payload } };
        // Mirror the tabId routing of postMessage so the background forwards chunks correctly.
        if (this.tabId) {
          chunkMsg.tabId = this.tabId;
        }
        this._port.postMessage(chunkMsg);
      }
    } catch (e) {
      // The port likely disconnected mid-send; let the caller requeue the original message.
      return false;
    }
    return true;
  }

  /**
   * Accumulates an incoming chunk and, once all chunks for its id have arrived, reassembles the
   * original message.
   * @param {Object} message An incoming port message.
   * @returns {Object|null|undefined} The reassembled message, null if the message wasn't a chunk
   *   (dispatch it as-is), or undefined if the message is an incomplete/failed chunk (dispatch nothing).
   * @private
   */
  _receiveChunk(message) {
    const ch = message && message.__webgpuInspectorChunk;
    if (!ch) {
      return null;
    }
    let buf = this._chunkRecv.get(ch.id);
    if (!buf) {
      buf = { count: ch.count, parts: new Array(ch.count), received: 0 };
      this._chunkRecv.set(ch.id, buf);
    }
    if (buf.parts[ch.index] === undefined) {
      buf.received++;
    }
    buf.parts[ch.index] = ch.payload;
    if (buf.received < buf.count) {
      return undefined;
    }
    this._chunkRecv.delete(ch.id);
    try {
      return JSON.parse(buf.parts.join(""));
    } catch (e) {
      console.error(`[WebGPU Inspector] Failed to reassemble chunked message on port ${this.name}:`, e);
      return undefined;
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

// Max payload size for a single chunk, in characters of the serialized message. Kept well under
// Chrome's 64MiB per-message port limit to leave headroom for the chunk wrapper and clone overhead.
MessagePort.chunkSize = 32 * 1024 * 1024;
