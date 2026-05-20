// Page-side client for the WebGPU Inspector Claude Code plugin's live bridge.
//
// This is the "local server" side of the inspector: it is constructed only
// when a page explicitly calls `webgpuInspector.initializeServer()`. Pages
// that use the normal `initialize()` / `saveCaptureData()` file-download flow
// never create one, so no socket is ever opened for regular usage.
//
// Responsibilities:
//  - Maintain a WebSocket connection to the bridge server (the plugin).
//  - On a `capture` request, drive the inspector's existing local-capture API
//    (`beginFrameCapture()` / `endFrameCapture()`) around the page's frames.
//  - Build the capture JSON with `saveCaptureData({ download: false })` and
//    upload it to the bridge over HTTP instead of downloading a file.
//
// The bridge server lives in `claude-plugin/server/` and is what Claude talks
// to over MCP. This file only knows how to talk to that bridge; it has no
// dependency on the plugin itself.

const DEFAULT_URL = "ws://localhost:9690/page";

// If a capture is requested but the page does not produce a new animation
// frame within this window, fall back to an immediate begin/end capture so a
// non-rAF (e.g. compute-only) page still yields a capture.
const FRAME_WAIT_MS = 3000;

export class BridgeClient {
  constructor(inspector, options) {
    this._inspector = inspector;
    options = options || {};

    this._url = options.url || DEFAULT_URL;
    this._httpBase = options.httpBase || _deriveHttpBase(this._url);
    this._token = options.token || null;
    this._name = options.name || _defaultName();
    this._autoReconnect = options.autoReconnect !== false;

    this._ws = null;
    this._connected = false;
    this._closed = false;
    this._reconnectTimer = null;

    // Capture driver state.
    this._capturing = false;
    this._activeRequestId = null;
    this._framesRemaining = 0;
    this._fallbackTimer = null;

    this._installRafHook();
  }

  // --- Connection -----------------------------------------------------------

  connect() {
    if (this._closed || this._ws) {
      return;
    }
    let ws;
    try {
      ws = new WebSocket(this._url);
    } catch (e) {
      this._log("failed to open WebSocket:", e && e.message);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.addEventListener("open", () => {
      this._connected = true;
      this._log("connected to bridge at", this._url);
      this._send({
        type: "hello",
        name: this._name,
        url: _location(),
        userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
        isWorker: typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope,
        hasRequestAnimationFrame: typeof self.requestAnimationFrame === "function"
      });
    });

    ws.addEventListener("message", (event) => this._onMessage(event));

    ws.addEventListener("close", () => {
      this._connected = false;
      this._ws = null;
      if (!this._closed) {
        this._scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      // The close handler drives reconnect; nothing extra to do here.
    });
  }

  close() {
    this._closed = true;
    this._autoReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch (e) { /* ignore */ }
      this._ws = null;
    }
  }

  _scheduleReconnect() {
    if (!this._autoReconnect || this._closed || this._reconnectTimer) {
      return;
    }
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  _send(obj) {
    if (this._ws && this._connected) {
      try {
        this._ws.send(JSON.stringify(obj));
      } catch (e) {
        this._log("send failed:", e && e.message);
      }
    }
  }

  _onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    switch (msg && msg.type) {
      case "capture":
        this._startCapture(msg);
        break;
      case "ping":
        this._send({ type: "pong" });
        break;
      default:
        break;
    }
  }

  // --- Capture driver -------------------------------------------------------

  // Wrap requestAnimationFrame so that, while a capture is in progress, each
  // frame the page renders is bracketed by begin/endFrameCapture. The hook is
  // a no-op passthrough whenever no capture is active.
  _installRafHook() {
    if (typeof self.requestAnimationFrame !== "function") {
      return; // Worker / non-rAF context: the immediate fallback handles it.
    }
    const origRaf = self.requestAnimationFrame.bind(self);
    const client = this;
    self.requestAnimationFrame = function (callback) {
      return origRaf(function (time) {
        if (client._framesRemaining > 0) {
          client._inspector.beginFrameCapture();
          try {
            callback(time);
          } finally {
            client._inspector.endFrameCapture();
            client._onFrameCaptured();
          }
        } else {
          callback(time);
        }
      });
    };
  }

  _startCapture(msg) {
    if (this._capturing) {
      this._send({
        type: "captureError",
        requestId: msg.requestId,
        message: "A capture is already in progress."
      });
      return;
    }
    this._capturing = true;
    this._activeRequestId = msg.requestId;
    this._framesRemaining = Math.max(1, (msg.frames | 0) || 1);

    this._send({
      type: "captureStarted",
      requestId: msg.requestId,
      frames: this._framesRemaining
    });

    this._armFallback();
  }

  _armFallback() {
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
    }
    this._fallbackTimer = setTimeout(() => {
      this._fallbackTimer = null;
      this._immediateCapture();
    }, FRAME_WAIT_MS);
  }

  _onFrameCaptured() {
    this._framesRemaining--;
    if (this._framesRemaining > 0) {
      this._armFallback();
    } else {
      if (this._fallbackTimer) {
        clearTimeout(this._fallbackTimer);
        this._fallbackTimer = null;
      }
      this._finishCapture();
    }
  }

  // The page did not render a frame in time (no rAF loop, or it stalled).
  // Capture whatever GPU work happens within a single synchronous begin/end
  // pair so the request still resolves with a valid (if possibly empty) file.
  _immediateCapture() {
    if (!this._capturing || this._framesRemaining <= 0) {
      return;
    }
    this._inspector.beginFrameCapture();
    this._inspector.endFrameCapture();
    this._framesRemaining = 0;
    this._finishCapture();
  }

  async _finishCapture() {
    const requestId = this._activeRequestId;
    try {
      const data = await this._inspector.saveCaptureData(undefined, { download: false });
      await this._upload(requestId, data);
      this._send({
        type: "captureComplete",
        requestId,
        frame: data && data.frame,
        commands: data && data.commands ? data.commands.length : 0,
        objects: data && data.objects ? Object.keys(data.objects).length : 0
      });
    } catch (e) {
      this._send({
        type: "captureError",
        requestId,
        message: (e && e.message) ? e.message : String(e)
      });
    } finally {
      this._capturing = false;
      this._activeRequestId = null;
    }
  }

  async _upload(requestId, data) {
    let url = `${this._httpBase}/capture/${encodeURIComponent(requestId)}`;
    if (this._token) {
      url += `?token=${encodeURIComponent(this._token)}`;
    }
    // text/plain keeps this a CORS "simple request" (no preflight); the bridge
    // parses the body as JSON regardless of the declared content type.
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      throw new Error(`Capture upload failed: HTTP ${response.status}`);
    }
  }

  _log(...args) {
    if (typeof console !== "undefined" && console.log) {
      console.log("[webgpu-inspector bridge]", ...args);
    }
  }
}

function _deriveHttpBase(wsUrl) {
  try {
    const u = new URL(wsUrl);
    const protocol = u.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${u.host}`;
  } catch (e) {
    return "http://localhost:9690";
  }
}

function _location() {
  try {
    if (typeof self.location !== "undefined" && self.location) {
      return self.location.href;
    }
  } catch (e) { /* ignore */ }
  return "";
}

function _defaultName() {
  const loc = _location();
  return loc || "webgpu-page";
}
