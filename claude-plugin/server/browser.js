// CDP-based instrumentation: drive Chrome directly (no browser extension) and
// inject the WebGPU Inspector into every page.
//
// For each page target, the controller registers the inspector source plus an
// `initializeServer()` call to run before any page script (the CDP equivalent
// of a document_start MAIN-world injection). It also calls Page.setBypassCSP
// so the page can reach the localhost bridge even under a strict
// Content-Security-Policy. The injected page then connects to the bridge on
// its own, exactly as a manually-instrumented page would.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

import puppeteer from "puppeteer-core";

const CDN_URL =
  "https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js";

export class BrowserController {
  constructor(options) {
    options = options || {};
    this._bridgeWsUrl = options.bridgeWsUrl || "ws://localhost:9690/page";
    this._token = options.token || null;
    this._scriptSpec = options.inspectorScript || null;
    this._log = options.log || (() => {});

    this._inspectorSource = null;
    this._browser = null;
    this._mode = null;          // "launch" | "attach"
    this._launched = false;
    this._instrumenting = new Map(); // puppeteer Target -> Promise<instanceId>
    this._pages = new Map();         // instanceId -> { target, url }
  }

  isConnected() {
    return !!this._browser;
  }

  status() {
    return {
      connected: !!this._browser,
      mode: this._mode,
      instrumentedPages: [...this._pages.entries()].map(([id, p]) => ({
        instanceId: id,
        url: p.url
      }))
    };
  }

  // --- Connecting ----------------------------------------------------------

  async launch(options) {
    options = options || {};
    if (this._browser) {
      throw new Error(`Already connected to a browser in ${this._mode} mode. Detach first.`);
    }
    await this._loadInspectorSource();

    const executablePath = options.executablePath || findChrome();
    if (!executablePath) {
      throw new Error("Could not find a Chrome/Edge executable. Pass executablePath, " +
        "or set the WEBGPU_BRIDGE_CHROME environment variable.");
    }
    const userDataDir = options.userDataDir ||
      join(os.tmpdir(), `webgpu-inspector-profile-${Date.now()}`);

    this._log(`launching browser: ${executablePath}`);
    this._browser = await puppeteer.launch({
      executablePath,
      headless: options.headless === true,
      userDataDir,
      defaultViewport: null,
      args: ["--no-first-run", "--no-default-browser-check"]
    });
    this._mode = "launch";
    this._launched = true;
    await this._afterConnect(false);

    if (options.url) {
      const opened = await this.openPage(options.url);
      return { ...this.status(), opened };
    }
    return this.status();
  }

  async attach(options) {
    options = options || {};
    if (this._browser) {
      throw new Error(`Already connected to a browser in ${this._mode} mode. Detach first.`);
    }
    await this._loadInspectorSource();

    const browserURL = options.browserURL || "http://localhost:9222";
    this._log(`attaching to browser at ${browserURL}`);
    this._browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    this._mode = "attach";
    this._launched = false;
    await this._afterConnect(options.reloadPages === true);

    return this.status();
  }

  async _afterConnect(reloadExisting) {
    this._browser.on("targetcreated", (t) => this._onTarget(t));
    this._browser.on("targetdestroyed", (t) => this._onTargetGone(t));
    this._browser.on("disconnected", () => {
      this._log("browser disconnected");
      this._browser = null;
      this._mode = null;
      this._instrumenting.clear();
      this._pages.clear();
    });

    // Future documents are covered by Page.addScriptToEvaluateOnNewDocument.
    // The current document of an already-open page is not, so optionally
    // reload real pages to bring the inspector into place before WebGPU runs.
    for (const page of await this._browser.pages()) {
      try {
        await this._instrumentPage(page);
        if (reloadExisting && isRealPage(page.url())) {
          await page.reload();
        }
      } catch (e) {
        this._log(`could not instrument an existing page: ${e.message}`);
      }
    }
  }

  // --- Instrumentation -----------------------------------------------------

  async _onTarget(target) {
    if (target.type() !== "page") {
      return;
    }
    let page;
    try {
      page = await target.page();
    } catch (e) {
      return;
    }
    if (!page) {
      return;
    }
    try {
      await this._instrumentPage(page);
    } catch (e) {
      this._log(`failed to instrument ${target.url()}: ${e.message}`);
    }
  }

  _onTargetGone(target) {
    const promise = this._instrumenting.get(target);
    if (promise) {
      this._instrumenting.delete(target);
      promise.then((instanceId) => this._pages.delete(instanceId)).catch(() => {});
    }
  }

  // Instrument a page exactly once. Concurrent callers (the targetcreated
  // handler and openPage) share one in-flight promise, so a caller that
  // awaits this is guaranteed the injection is fully registered — important
  // because openPage must not navigate before evaluateOnNewDocument lands.
  _instrumentPage(page) {
    const target = page.target();
    let promise = this._instrumenting.get(target);
    if (promise) {
      return promise;
    }
    promise = this._doInstrumentPage(page, target);
    this._instrumenting.set(target, promise);
    // Drop a cached rejection so instrumentation can be retried.
    promise.catch(() => this._instrumenting.delete(target));
    return promise;
  }

  async _doInstrumentPage(page, target) {
    const instanceId = randomUUID();
    this._pages.set(instanceId, { target, url: page.url() });

    try {
      // Let the page open a WebSocket / fetch to the localhost bridge even
      // when it ships a restrictive connect-src CSP.
      await page.setBypassCSP(true);
    } catch (e) {
      this._log(`setBypassCSP failed (continuing): ${e.message}`);
    }
    await page.evaluateOnNewDocument(this._buildInjection(instanceId));

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        const record = this._pages.get(instanceId);
        if (record) {
          record.url = page.url();
        }
      }
    });

    this._log(`instrumented page ${instanceId} (${page.url() || "blank"})`);
    return instanceId;
  }

  // Open a new tab, instrument it, and navigate it. The inspector is
  // registered before navigation so it patches WebGPU before the page runs.
  async openPage(url) {
    if (!this._browser) {
      throw new Error("No browser connected. Use launch_browser or attach_browser first.");
    }
    const page = await this._browser.newPage();
    const instanceId = await this._instrumentPage(page);
    if (url) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        this._log(`navigation to ${url} reported: ${e.message}`);
      }
    }
    return { instanceId, url: page.url() };
  }

  async dispose() {
    if (!this._browser) {
      return;
    }
    const browser = this._browser;
    this._browser = null;
    try {
      if (this._launched) {
        await browser.close();
      } else {
        browser.disconnect();
      }
    } catch (e) {
      /* ignore */
    }
  }

  // --- Helpers -------------------------------------------------------------

  _buildInjection(instanceId) {
    const opts = { url: this._bridgeWsUrl, name: instanceId };
    if (this._token) {
      opts.token = this._token;
    }
    return `${this._inspectorSource}
;(function () {
  try {
    window.webgpuInspector.initializeServer(${JSON.stringify(opts)});
  } catch (e) {
    console.error("[webgpu-inspector] bridge init failed:", e);
  }
})();`;
  }

  async _loadInspectorSource() {
    if (this._inspectorSource) {
      return this._inspectorSource;
    }
    let spec = this._scriptSpec;
    if (!spec) {
      // Prefer the locally built inspector when the plugin lives in the repo.
      const here = dirname(fileURLToPath(import.meta.url));
      const local = join(here, "..", "..", "extensions", "chrome", "webgpu_inspector.js");
      spec = existsSync(local) ? local : CDN_URL;
    }
    if (/^https?:\/\//i.test(spec)) {
      this._log(`fetching inspector script: ${spec}`);
      const res = await fetch(spec);
      if (!res.ok) {
        throw new Error(`Failed to fetch inspector script (HTTP ${res.status}): ${spec}`);
      }
      this._inspectorSource = await res.text();
    } else {
      this._log(`reading inspector script: ${spec}`);
      this._inspectorSource = readFileSync(spec, "utf8");
    }
    return this._inspectorSource;
  }
}

function isRealPage(url) {
  return !!url &&
    url !== "about:blank" &&
    !url.startsWith("chrome://") &&
    !url.startsWith("devtools://") &&
    !url.startsWith("edge://");
}

function findChrome() {
  if (process.env.WEBGPU_BRIDGE_CHROME) {
    return process.env.WEBGPU_BRIDGE_CHROME;
  }
  const candidates = [];
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"];
    candidates.push(
      join(pf, "Google\\Chrome\\Application\\chrome.exe"),
      join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
      local ? join(local, "Google\\Chrome\\Application\\chrome.exe") : null,
      join(pf, "Google\\Chrome Beta\\Application\\chrome.exe"),
      join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf, "Microsoft\\Edge\\Application\\msedge.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge"
    );
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
