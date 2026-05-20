// Entry point for the WebGPU Inspector bridge + MCP server.
//
// Started by Claude Code via the plugin's .mcp.json. It runs three things in
// one process:
//   - an MCP server over stdio (Claude talks to this)
//   - a localhost HTTP/WebSocket bridge (instrumented pages connect to this)
//   - a CDP browser controller (drives Chrome and injects the inspector)
//
// stdout is reserved for the MCP JSON-RPC stream; ALL logging goes to stderr.

import process from "node:process";
import { join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CaptureStore } from "./capture-store.js";
import { Bridge } from "./bridge.js";
import { BrowserController } from "./browser.js";
import { createMcpServer } from "./mcp.js";

const VERSION = "0.1.0";

function log(message) {
  process.stderr.write(`[webgpu-bridge] ${message}\n`);
}

async function main() {
  const port = parseInt(process.env.WEBGPU_BRIDGE_PORT || "9690", 10);
  const host = process.env.WEBGPU_BRIDGE_HOST || "127.0.0.1";
  const token = process.env.WEBGPU_BRIDGE_TOKEN || null;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
  const capturesDir = process.env.WEBGPU_BRIDGE_CAPTURES_DIR || join(pluginRoot, "captures");

  const store = new CaptureStore({ dir: capturesDir });
  await store.init();
  log(`captures directory: ${capturesDir}`);

  const bridge = new Bridge({ port, host, token, store, log });
  await bridge.start();
  if (token) {
    log("token authentication is enabled.");
  }

  const browser = new BrowserController({
    bridgeWsUrl: `ws://localhost:${port}/page`,
    token,
    inspectorScript: process.env.WEBGPU_INSPECTOR_SCRIPT || null,
    log
  });

  const shutdown = async () => {
    try {
      await browser.dispose();
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const server = createMcpServer({ store, bridge, browser, version: VERSION });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio.");
}

main().catch((err) => {
  log(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
