// MCP server: the tools Claude calls to drive captures and inspect them.
//
// Output discipline: tools return summaries, paginated slices, and decoded
// windows — never raw base64 texture/buffer blobs. Captures are multi-MB and
// would blow out the model's context.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import {
  summarize,
  listCommands,
  getObject,
  getShader
} from "./analysis.js";

export function createMcpServer(deps) {
  const store = deps.store;
  const bridge = deps.bridge;
  const browser = deps.browser;

  const server = new Server(
    { name: "webgpu-inspector", version: deps.version || "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // Resolve a captureId argument to its JSON; falls back to the most recent
  // capture when the argument is omitted.
  function resolveCapture(args) {
    let id = args && args.captureId;
    if (!id) {
      const latest = store.latest();
      if (!latest) {
        throw new Error("No captures available. Use capture_frames or load_capture_file first.");
      }
      id = latest.id;
    }
    const json = store.getJson(id);
    if (!json) {
      throw new Error(`No capture "${id}". Use list_captures to see what is available.`);
    }
    return { id, json };
  }

  const tools = [
    {
      name: "launch_browser",
      description: "Launch a new Chrome/Edge instance controlled by this plugin. Every page " +
        "it opens is automatically instrumented with the WebGPU Inspector — no extension and " +
        "no page changes needed. Optionally navigate a first tab to a URL.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Optional URL to open in a first instrumented tab." },
          headless: { type: "boolean", description: "Run headless (default false; WebGPU usually needs headful)." },
          executablePath: { type: "string", description: "Path to the Chrome/Edge binary (auto-detected if omitted)." }
        }
      }
    },
    {
      name: "attach_browser",
      description: "Attach to an already-running Chrome/Edge that was started with " +
        "--remote-debugging-port. New tabs and navigations are instrumented automatically.",
      inputSchema: {
        type: "object",
        properties: {
          browserURL: { type: "string", description: "Debugger URL (default http://localhost:9222)." },
          reloadPages: { type: "boolean", description: "Reload already-open tabs so they get instrumented now (default false)." }
        }
      }
    },
    {
      name: "open_page",
      description: "Open a new instrumented tab in the controlled browser and navigate it to " +
        "a URL. Waits for the page to connect to the bridge and returns it ready to capture.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open." }
        },
        required: ["url"]
      }
    },
    {
      name: "browser_status",
      description: "Report whether a controlled browser is connected, how it was connected, " +
        "which targets are instrumented, and which pages have connected to the bridge.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "list_pages",
      description: "List browser pages currently connected to the live bridge. " +
        "A page connects after it is instrumented (via launch_browser/open_page) or after " +
        "it calls webgpuInspector.initializeServer() itself.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "capture_frames",
      description: "Ask a connected page to capture one or more WebGPU frames, then " +
        "return a summary of the resulting capture (command/draw/pass counts, object " +
        "counts, validation errors, flagged issues). Use list_pages first if unsure.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: {
            type: "string",
            description: "Page to capture from. Optional when exactly one page is connected."
          },
          frames: {
            type: "integer",
            description: "Number of frames to capture (default 1).",
            minimum: 1
          },
          maxBufferSize: {
            type: "integer",
            description: "Optional cap, in bytes, on captured uniform/storage buffer data."
          }
        }
      }
    },
    {
      name: "list_captures",
      description: "List captures currently available to analyze (both live captures " +
        "and capture files that were explicitly loaded).",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "load_capture_file",
      description: "Load a WebGPU Inspector capture .json file from disk (one saved by " +
        "saveCaptureData() or the DevTools 'Save Capture' action) so it can be analyzed.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the capture .json file." }
        },
        required: ["path"]
      }
    },
    {
      name: "get_capture_summary",
      description: "Summarize a capture: object counts by type, command counts by method, " +
        "derived render statistics, shader entry points, validation error count, and " +
        "heuristic performance/correctness issues.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string", description: "Capture id (default: most recent)." }
        }
      }
    },
    {
      name: "get_commands",
      description: "Return a paginated, base64-stripped slice of a capture's command list. " +
        "Each entry has its index, method, pass number, object, and arguments.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string", description: "Capture id (default: most recent)." },
          offset: { type: "integer", description: "Start index into the (filtered) list.", minimum: 0 },
          limit: { type: "integer", description: "Max entries to return (default 50, max 500).", minimum: 1 },
          method: { type: "string", description: "Optional: only commands with this method name." }
        }
      }
    },
    {
      name: "get_object",
      description: "Return one GPU object record from a capture (descriptor, label, " +
        "stacktrace), with base64 payloads omitted.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string", description: "Capture id (default: most recent)." },
          objectId: { type: "integer", description: "Numeric object id." }
        },
        required: ["objectId"]
      }
    },
    {
      name: "get_shader",
      description: "Return the WGSL source code of a ShaderModule object in a capture.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string", description: "Capture id (default: most recent)." },
          objectId: { type: "integer", description: "Numeric id of the ShaderModule object." }
        },
        required: ["objectId"]
      }
    },
    {
      name: "get_validation_errors",
      description: "Return the WebGPU validation errors recorded during a capture.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string", description: "Capture id (default: most recent)." }
        }
      }
    }
  ];

  const handlers = {
    launch_browser: async (args) => {
      const result = await browser.launch({
        url: args.url,
        headless: args.headless,
        executablePath: args.executablePath
      });
      const out = { browser: browser.status() };
      if (result.opened && result.opened.instanceId) {
        out.targetUrl = result.opened.url;
        out.openedPage = await bridge.waitForPage(result.opened.instanceId, 20000);
        if (!out.openedPage) {
          out.note = "The tab opened but did not connect to the bridge within 20s. " +
            "It may not use WebGPU yet, or it created WebGPU objects before the page finished loading.";
        }
      }
      return out;
    },

    attach_browser: async (args) => {
      const status = await browser.attach({
        browserURL: args.browserURL,
        reloadPages: args.reloadPages
      });
      return { browser: status, pages: bridge.listPages() };
    },

    open_page: async (args) => {
      if (!args || !args.url) {
        throw new Error("url is required.");
      }
      const opened = await browser.openPage(args.url);
      const page = await bridge.waitForPage(opened.instanceId, 20000);
      return {
        targetUrl: opened.url,
        openedPage: page,
        note: page
          ? undefined
          : "The tab opened but did not connect to the bridge within 20s. It may not " +
            "use WebGPU, or there may be an error in the page console."
      };
    },

    browser_status: async () => ({
      browser: browser.status(),
      pages: bridge.listPages()
    }),

    list_pages: async () => ({
      bridgeListening: bridge.isListening(),
      pages: bridge.listPages()
    }),

    capture_frames: async (args) => {
      const meta = await bridge.requestCapture({
        pageId: args.pageId,
        frames: args.frames,
        maxBufferSize: args.maxBufferSize
      });
      const json = store.getJson(meta.id);
      return { captureId: meta.id, summary: summarize(json) };
    },

    list_captures: async () => ({ captures: store.list() }),

    load_capture_file: async (args) => {
      if (!args || !args.path) {
        throw new Error("path is required.");
      }
      const meta = await store.addFile(args.path);
      const json = store.getJson(meta.id);
      return { captureId: meta.id, summary: summarize(json) };
    },

    get_capture_summary: async (args) => {
      const { id, json } = resolveCapture(args);
      return { captureId: id, summary: summarize(json) };
    },

    get_commands: async (args) => {
      const { id, json } = resolveCapture(args);
      return {
        captureId: id,
        ...listCommands(json, {
          offset: args.offset,
          limit: args.limit,
          method: args.method
        })
      };
    },

    get_object: async (args) => {
      const { id, json } = resolveCapture(args);
      const obj = getObject(json, args.objectId);
      if (!obj) {
        throw new Error(`No object #${args.objectId} in capture ${id}.`);
      }
      return { captureId: id, object: obj };
    },

    get_shader: async (args) => {
      const { id, json } = resolveCapture(args);
      return { captureId: id, ...getShader(json, args.objectId) };
    },

    get_validation_errors: async (args) => {
      const { id, json } = resolveCapture(args);
      return {
        captureId: id,
        validationErrors: Array.isArray(json.validationErrors) ? json.validationErrors : []
      };
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const handler = handlers[name];
    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true
      };
    }
    try {
      const result = await handler(args);
      const text = typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e && e.message ? e.message : String(e)}` }],
        isError: true
      };
    }
  });

  return server;
}
