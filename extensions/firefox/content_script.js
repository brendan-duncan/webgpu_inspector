(function () {
  'use strict';

  /**
   * Manages a Chrome extension message port connection with automatic reconnection
   * and message queuing capabilities.
   */
  class MessagePort {
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

  const Actions = {
    CaptureBufferData: "webgpu_inspect_capture_buffer_data",
    CaptureBuffers: "webgpu_inspect_capture_buffers",
    DeleteObjects: "webgpu_inspect_delete_objects",
    ValidationError: "webgpu_inspect_validation_error",
    MemoryLeakWarning: "webgpu_inspect_memory_leak_warning",
    DeltaTime: "webgpu_inspect_delta_time",
    CaptureFrameResults: "webgpu_inspect_capture_frame_results",
    CaptureFrameCommands: "webgpu_inspect_capture_frame_commands",
    ObjectSetLabel: "webgpu_inspect_object_set_label",
    AddObject: "webgpu_inspect_add_object",
    ResolveAsyncObject: "webgpu_inspect_resolve_async_object",
    DeleteObject: "webgpu_inspect_delete_object",
    CaptureTextureFrames: "webgpu_inspect_capture_texture_frames",
    CaptureTextureData: "webgpu_inspect_capture_texture_data",
    CaptureBufferData: "webgpu_inspect_capture_buffer_data",
    WriteBuffer: "wrebgpu_inspect_write_buffer",

    Recording: "webgpu_record_recording",
    RecordingCommand: "webgpu_record_command",
    RecordingDataCount: "webgpu_record_data_count",
    RecordingData: "webgpu_record_data",

    // Connection handshake actions. Sent automatically by MessagePort on every
    // (re)connect via its readyAction option so the background can re-register
    // each port after a service-worker restart.
    PageReady: "webgpu_inspect_page_ready",
    PanelReady: "webgpu_inspect_panel_ready",
  };

  Actions.values = new Set(Object.values(Actions));

  const PanelActions = {
    RequestTexture: "webgpu_inspect_request_texture",
    CompileShader: "webgpu_inspect_compile_shader",
    RevertShader: "webgpu_inspect_revert_shader",
    Capture: "webgpu_inspector_capture",
    InitializeInspector: "webgpu_initialize_inspector",
    InitializeRecorder: "webgpu_initialize_recorder",
    // Runtime trigger for on-demand (stateful, recordMode 2) recording. Forwarded by the
    // content script to the page as a "webgpu_recorder_record_frame" __WebGPURecorder event.
    RecordFrame: "webgpu_record_frame"
  };

  /**
   * The content script runs in the context of the web page, can send and receive messages
   * to/from the extension background script, and can inject scripts into the web page.
   * We use this to inject the webgpu_inspector_loader.js script into the page context,
   * and register to listen to messages from the background script and forward them to the page,
   * as well as messages from the page to the background script.
   * @module content_script
   */

  const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
  const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
  const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";
  // Tells the injected inspector whether to inject itself into Web Workers.
  // Driven by the DevTools panel's "Inspect Workers" setting; off by default.
  const webgpuInspectorWorkersKey = "WEBGPU_INSPECTOR_WORKERS";

  /** Reload delay in milliseconds */
  const RELOAD_DELAY_MS = 50;

  /**
   * True when this content script is running in the top-level frame (not an iframe).
   * Comparing window references is allowed across origins; only property access throws.
   * @returns {boolean}
   */
  function isTopFrame() {
    return window === window.top;
  }

  /**
   * Reloads the page to (re)start the inspector/recorder from the sessionStorage
   * key each frame set above.
   *
   * Only the top frame actually reloads: reloading the top document recreates the
   * entire subframe tree, and every recreated frame's loader auto-starts from its
   * own-origin key. If subframes also self-reloaded, a cross-origin iframe whose
   * timer fired before the top frame's would start, consume (clear) its own-origin
   * key on its load event, and then be recreated key-less by the top reload —
   * leaving that frame permanently un-inspected. Letting only the top frame reload
   * removes that race. Subframes still set their sessionStorage key (above) so they
   * are ready when the top reload recreates them.
   */
  function reloadFromTopFrame() {
    if (!isTopFrame()) {
      return;
    }
    setTimeout(function () {
      window.location.reload();
    }, RELOAD_DELAY_MS);
  }

  /**
   * Checks if the browser is Firefox.
   * @returns {boolean} True if running in Firefox
   */
  function isFirefox() {
    return navigator.userAgent.toLowerCase().includes('firefox');
  }

  /**
   * Checks if the browser is Chrome-based (Chrome, Edge, etc.)
   * @returns {boolean} True if running in a Chromium-based browser
   */
  function isChromium() {
    return navigator.userAgent.indexOf("Chrom") !== -1;
  }

  /**
   * Forwards a valid inspector message to the background script.
   * @param {Object} message - The message to forward
   */
  function forwardToBackground(message) {
    if (!message.action || !Actions.values.has(message.action)) {
      return;
    }

    try {
      port.postMessage(message);
    } catch (e) {
      console.error("[WebGPU Inspector] Error sending message from page:", e);
    }
  }

  /**
   * Forwards a valid inspector/recorder message to the background script.
   * @param {CustomEvent} event - The event containing the message
   */
  function handleMessageEvent(event) {
    const message = event.detail;
    if (typeof message !== 'object' || message === null) {
      return;
    }
    forwardToBackground(message);
  }

  /**
   * Injects a script element into the document.
   * @param {string} name - The id name for the script
   * @param {string} url - The URL of the script
   * @param {Object|null} attributes - Optional attributes to set on the script
   */
  function injectScriptNode(name, url, attributes) {
    const script = document.createElement("script");
    script.id = name;
    script.src = url;

    if (attributes) {
      for (const key in attributes) {
        script.setAttribute(key, attributes[key]);
      }
    }

    (document.head || document.documentElement).appendChild(script);
  }

  // Create a message port to communicate with the background script.
  // readyAction posts PageReady on every (re)connect so the background can
  // re-register this port after a service-worker restart without waiting for
  // user-driven traffic.
  const port = new MessagePort("webgpu-inspector-page", 0, (message) => {
    let action = message.action;
    if (!action) {
      return;
    }

    // PanelReady arrives whenever the panel reconnects. It exists to register the
    // panel port in the background; the content script doesn't need to do anything
    // with it.
    if (action === Actions.PanelReady) {
      return;
    }

    if (action === PanelActions.RequestTexture || action === PanelActions.CompileShader || action === PanelActions.RevertShader) {
      const msg = isFirefox() ? cloneInto(message, document.defaultView) : message;
      window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: msg }));
      return;
    }

    if (action === PanelActions.InitializeRecorder) {
      // Field order: frames%filename%download%recordMode%recordFrame%continuous%output
      // recordFrame is a (possibly empty) comma-joined list of absolute frame indices.
      const recordMode = message.recordMode ?? 0;
      const recordFrame = message.recordFrame ?? "";
      const continuous = message.continuous ? "true" : "false";
      const output = message.output || "html";
      sessionStorage.setItem(webgpuRecorderLoadedKey,
        `${message.frames}%${message.filename}%${message.download}%${recordMode}%${recordFrame}%${continuous}%${output}`);
      reloadFromTopFrame();
      return;
    }

    // On-demand capture trigger for a recorder already running in stateful mode. Forward it to the
    // page as the recorder's "webgpu_recorder_record_frame" event (also picked up by worker recorders).
    if (action === PanelActions.RecordFrame) {
      const detail = { __webgpuRecorder: true, action: "webgpu_recorder_record_frame" };
      if (typeof message.frame === "number") {
        detail.frame = message.frame;
      }
      const msg = isFirefox() ? cloneInto(detail, document.defaultView) : detail;
      window.dispatchEvent(new CustomEvent("__WebGPURecorder", { detail: msg }));
      return;
    }

    // If a capture is requested and either the inspector hasn't been initialized yet or the frame is not -1,
    // we need to initialize the inspector. If the frame is not -1, then a specific frame has been requested
    // to be captured. We need to put this information into the inspector initialization so that it doesn't
    // get lost in the reload.
    let inspectMessage = "true";
    if (action === PanelActions.Capture) {
      const messageString = JSON.stringify(message);
      if (message.frame >= 0) {
        action = PanelActions.InitializeInspector;
        inspectMessage = messageString;
      } else {
        sessionStorage.setItem(webgpuInspectorCaptureFrameKey, messageString);
        const captureMsg = { __webgpuInspector: true, __webgpuInspectorPanel: true, action: PanelActions.Capture,
          data: messageString };
        const msg = isFirefox() ? cloneInto(captureMsg, document.defaultView) : captureMsg;
        window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: msg }));
      }
    }
    
    if (action === PanelActions.InitializeInspector) {
      sessionStorage.setItem(webgpuInspectorLoadedKey, inspectMessage);
      // Carry the panel's "Inspect Workers" choice across the reload. Both the
      // Inspect panel (InitializeInspector) and the Capture panel (Capture with
      // a specific frame, which is routed here) set message.inspectWorkers.
      if (message.inspectWorkers) {
        sessionStorage.setItem(webgpuInspectorWorkersKey, "true");
      } else {
        sessionStorage.removeItem(webgpuInspectorWorkersKey);
      }
      reloadFromTopFrame();
    }
  }, Actions.PageReady);

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      port.reset();
    }
  });

  // Listen for messages from the page and forward to background script
  window.addEventListener("__WebGPUInspector", handleMessageEvent);
  window.addEventListener("__WebGPURecorder", handleMessageEvent);

  // Fallback for browsers which don't support the "world" property on content_scripts
  if (!isChromium() && (navigator.userAgent.indexOf("Safari") !== -1 || isFirefox())) {
    if (sessionStorage.getItem(webgpuInspectorLoadedKey)) {
      injectScriptNode("__webgpu_inspector", chrome.runtime.getURL("webgpu_inspector_loader.js"));
    }

    const recordMessage = sessionStorage.getItem(webgpuRecorderLoadedKey);
    if (recordMessage) {
      const data = recordMessage.split("%");
      const attributes = {
        filename: data[1],
        frames: data[0],
        download: data[2],
        removeUnusedResources: 1,
        messageRecording: 1,
        recordMode: data[3] ?? "0"
      };
      // The recorder parses recordFrame's commas itself; only set it when non-empty.
      if (data[4]) {
        attributes.recordFrame = data[4];
      }
      // The recorder treats the mere presence of the continuous attribute as true, so only set it when on.
      if (data[5] === "true") {
        attributes.continuous = "true";
      }
      if (data[6]) {
        attributes.output = data[6];
      }
      injectScriptNode("__webgpu_recorder", chrome.runtime.getURL("webgpu_recorder_loader.js"), attributes);
    }
  }

  // PageReady is sent automatically by MessagePort on every (re)connect via readyAction.

})();
//# sourceMappingURL=content_script.js.map
