// Live bridge: a localhost HTTP + WebSocket endpoint that instrumented pages
// connect to. The MCP server (mcp.js) calls into this to push capture
// requests to pages and to await the uploaded results.
//
//   page  --WS /page-->            bridge  <--stdio MCP--  Claude Code
//   page  --POST /capture/:id-->   bridge
//
// Only pages that explicitly call webgpuInspector.initializeServer() connect
// here; nothing connects during normal file-download inspector usage.

import http from "node:http";
import { randomUUID } from "node:crypto";

import { WebSocketServer } from "ws";

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export class Bridge {
  constructor(options) {
    options = options || {};
    this._port = options.port || 9690;
    this._host = options.host || "127.0.0.1";
    this._token = options.token || null;
    this._store = options.store;
    this._log = options.log || (() => {});

    this._pages = new Map();   // pageId -> page record
    this._pending = new Map(); // requestId -> { resolve, reject, timer, pageId }
    this._pageWaiters = new Set(); // { name, resolve } awaiting a page by name
    this._pageCounter = 0;

    this._httpServer = null;
    this._wss = null;
    this._listening = false;
  }

  // Bind the HTTP/WS server. Resolves true on success, false if the port is
  // taken — a busy port is non-fatal so file-based MCP tools still work.
  start() {
    return new Promise((resolve) => {
      this._httpServer = http.createServer((req, res) => this._onHttp(req, res));
      this._wss = new WebSocketServer({ server: this._httpServer, path: "/page" });
      this._wss.on("connection", (ws, req) => this._onConnection(ws, req));

      this._httpServer.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          this._log(`port ${this._port} already in use — live capture disabled, ` +
            "file-based tools still work.");
        } else {
          this._log(`HTTP server error: ${err.message}`);
        }
        this._listening = false;
        resolve(false);
      });

      this._httpServer.listen(this._port, this._host, () => {
        this._listening = true;
        this._log(`listening on http://${this._host}:${this._port} (WebSocket path /page)`);
        resolve(true);
      });
    });
  }

  isListening() {
    return this._listening;
  }

  // --- WebSocket side: instrumented pages -----------------------------------

  _onConnection(ws, req) {
    if (this._token) {
      const url = new URL(req.url, "http://localhost");
      if (url.searchParams.get("token") !== this._token) {
        ws.close(4001, "invalid token");
        return;
      }
    }
    this._pageCounter++;
    const page = {
      pageId: `page-${this._pageCounter}`,
      ws,
      name: "",
      url: "",
      isWorker: false,
      hasRAF: true,
      connectedAt: new Date().toISOString()
    };
    this._pages.set(page.pageId, page);
    this._log(`page connected: ${page.pageId}`);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      this._onPageMessage(page, msg);
    });

    ws.on("close", () => {
      this._pages.delete(page.pageId);
      this._log(`page disconnected: ${page.pageId}`);
      for (const [requestId, pending] of [...this._pending]) {
        if (pending.pageId === page.pageId) {
          this._rejectPending(requestId, new Error("Page disconnected before the capture completed."));
        }
      }
    });

    ws.on("error", () => { /* close handler drives cleanup */ });
  }

  _onPageMessage(page, msg) {
    switch (msg && msg.type) {
      case "hello":
        page.name = msg.name || page.name;
        page.url = msg.url || "";
        page.isWorker = !!msg.isWorker;
        page.hasRAF = msg.hasRequestAnimationFrame !== false;
        this._log(`page ${page.pageId} identified: ${page.name || page.url || "(unnamed)"}`);
        // Resolve any waiter keyed on this page's name (set by the CDP
        // controller so open_page / launch_browser can return a ready page).
        for (const waiter of [...this._pageWaiters]) {
          if (waiter.name && waiter.name === page.name) {
            this._pageWaiters.delete(waiter);
            waiter.resolve(this._pageInfo(page));
          }
        }
        break;
      case "captureStarted":
        this._log(`page ${page.pageId} started capture ${msg.requestId} (${msg.frames} frame(s))`);
        break;
      case "captureComplete":
        // The capture payload itself arrives over HTTP POST; informational only.
        break;
      case "captureError":
        this._rejectPending(msg.requestId, new Error(msg.message || "Capture failed on the page."));
        break;
      default:
        break;
    }
  }

  _pageInfo(p) {
    return {
      pageId: p.pageId,
      name: p.name,
      url: p.url,
      isWorker: p.isWorker,
      hasRequestAnimationFrame: p.hasRAF,
      connectedAt: p.connectedAt
    };
  }

  listPages() {
    return [...this._pages.values()].map((p) => this._pageInfo(p));
  }

  // Resolve once a page connects whose `hello` name matches, or with null on
  // timeout. Used to correlate a CDP-opened tab with its bridge connection.
  waitForPage(name, timeoutMs) {
    return new Promise((resolve) => {
      for (const p of this._pages.values()) {
        if (p.name === name) {
          resolve(this._pageInfo(p));
          return;
        }
      }
      const waiter = { name, resolve };
      this._pageWaiters.add(waiter);
      setTimeout(() => {
        if (this._pageWaiters.delete(waiter)) {
          resolve(null);
        }
      }, timeoutMs || 15000);
    });
  }

  // Ask a page to capture N frames. Resolves with the stored capture metadata
  // once the page uploads the result.
  requestCapture(opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      if (!this._listening) {
        reject(new Error("Bridge is not listening, so live capture is unavailable."));
        return;
      }
      const pages = [...this._pages.values()];
      if (pages.length === 0) {
        reject(new Error("No instrumented pages connected. Load your page after calling " +
          "webgpuInspector.initializeServer()."));
        return;
      }
      let page;
      if (opts.pageId) {
        page = this._pages.get(opts.pageId);
        if (!page) {
          reject(new Error(`No connected page with id "${opts.pageId}".`));
          return;
        }
      } else if (pages.length === 1) {
        page = pages[0];
      } else {
        reject(new Error(`${pages.length} pages connected (${pages.map((p) => p.pageId).join(", ")}). ` +
          "Pass pageId to choose one."));
        return;
      }

      const requestId = randomUUID();
      const frames = Math.max(1, (opts.frames | 0) || 1);
      const timeoutMs = opts.timeoutMs || 45000;
      const timer = setTimeout(() => {
        this._rejectPending(requestId, new Error(`Capture timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this._pending.set(requestId, { resolve, reject, timer, pageId: page.pageId });

      const message = { type: "capture", requestId, frames };
      if (opts.maxBufferSize) {
        message.maxBufferSize = opts.maxBufferSize;
      }
      try {
        page.ws.send(JSON.stringify(message));
      } catch (e) {
        this._rejectPending(requestId, new Error(`Failed to send capture request: ${e.message}`));
      }
    });
  }

  _rejectPending(requestId, err) {
    const pending = this._pending.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this._pending.delete(requestId);
    pending.reject(err);
  }

  _resolvePending(requestId, value) {
    const pending = this._pending.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this._pending.delete(requestId);
    pending.resolve(value);
    return true;
  }

  // --- HTTP side: capture uploads + health ----------------------------------

  _onHttp(req, res) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch (e) {
      res.writeHead(400, cors);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pages: this._pages.size }));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/capture/")) {
      this._handleUpload(req, res, url, cors);
      return;
    }
    res.writeHead(404, cors);
    res.end();
  }

  _handleUpload(req, res, url, cors) {
    if (this._token && url.searchParams.get("token") !== this._token) {
      res.writeHead(401, cors);
      res.end();
      return;
    }
    const requestId = decodeURIComponent(url.pathname.slice("/capture/".length));
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) {
        return;
      }
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        aborted = true;
        res.writeHead(413, cors);
        res.end();
        req.destroy();
        this._rejectPending(requestId, new Error("Uploaded capture exceeded the size limit."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", async () => {
      if (aborted) {
        return;
      }
      let json;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (e) {
        res.writeHead(400, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        this._rejectPending(requestId, new Error("Uploaded capture was not valid JSON."));
        return;
      }
      const pending = this._pending.get(requestId);
      const page = pending ? this._pages.get(pending.pageId) : null;
      try {
        const meta = await this._store.addLive(json, { pageName: page ? page.name : "" });
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, captureId: meta.id }));
        this._resolvePending(requestId, meta);
      } catch (e) {
        res.writeHead(500, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
        this._rejectPending(requestId, e);
      }
    });

    req.on("error", () => {
      this._rejectPending(requestId, new Error("Capture upload connection error."));
    });
  }
}
