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
  getShader,
  getDrawState,
  decodeVertexBuffer,
  diffDraws
} from "./analysis.js";

// Largest WGSL source returned by get_shader before truncation.
const MAX_SHADER_CHARS = 60000;
// Soft caps for clampResult, so no tool result blows out the model's context.
const MAX_STRING_CHARS = 20000;
const MAX_ARRAY_ITEMS = 1000;

// Defensively bound a tool result before it's serialized: long strings and big
// arrays are truncated with a clear marker rather than returned in full. This
// is a backstop — individual tools already paginate/slice — so a surprising
// large field degrades instead of flooding the context.
function clampResult(value, depth) {
  depth = depth || 0;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_CHARS) {
      return value.slice(0, MAX_STRING_CHARS) + `...[truncated, ${value.length - MAX_STRING_CHARS} more chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((v) => clampResult(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      out.push(`...[truncated, ${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = clampResult(value[k], depth + 1);
    }
    return out;
  }
  return value;
}

// Turn a live buffer readback ({ base64, byteLength, ... }) into typed numbers.
function decodeReadback(result, type) {
  if (!result || typeof result.base64 !== "string") {
    return result || { error: "No data returned." };
  }
  const bytes = Buffer.from(result.base64, "base64");
  const out = {
    bufferId: result.bufferId,
    offset: result.offset || 0,
    byteLength: bytes.length,
    type
  };
  if (result.truncated) {
    out.truncated = result.truncated;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = [];
  if (type === "hex") {
    out.hex = bytes.toString("hex");
    return out;
  }
  const sizes = { uint8: 1, uint16: 2, uint32: 4, int32: 4, float32: 4 };
  const step = sizes[type] || 4;
  for (let i = 0; i + step <= bytes.length; i += step) {
    switch (type) {
      case "uint8": values.push(dv.getUint8(i)); break;
      case "uint16": values.push(dv.getUint16(i, true)); break;
      case "uint32": values.push(dv.getUint32(i, true)); break;
      case "int32": values.push(dv.getInt32(i, true)); break;
      default: values.push(dv.getFloat32(i, true)); break;
    }
  }
  out.values = values;
  return out;
}

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
            description: "Optional cap, in bytes, applied to EVERY captured buffer payload " +
              "(vertex/index/storage/uniform/indirect). Buffers larger than this are truncated " +
              "to the first N bytes (recorded as truncated). Default 64KB. Use -1 to disable."
          },
          maxTextureSize: {
            type: "integer",
            description: "Optional cap, in bytes, on each captured texture's pixel data. Textures " +
              "larger than this are skipped (descriptor still recorded), keeping captures light. " +
              "Default 16MB. Use -1 to capture all texture data."
          },
          passLabel: {
            type: "string",
            description: "Optional: only capture heavy payloads (buffers/textures) for render/" +
              "compute passes whose label matches this regular expression. Greatly shrinks " +
              "captures of large frames by skipping unrelated passes (shadows, IBL, post)."
          },
          passType: {
            type: "string",
            enum: ["render", "compute"],
            description: "Optional: only capture heavy payloads for passes of this type."
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
          captureId: { type: "string", description: "Capture id (default: most recent)." },
          includeMethodCounts: { type: "boolean", description: "Include the per-method command counts map (default true)." },
          includeIssues: { type: "boolean", description: "Include heuristic performance/correctness issues (default true)." }
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
          method: { type: "string", description: "Optional: only commands with this method name." },
          passLabel: { type: "string", description: "Optional regex: only commands inside a render/compute pass whose label matches." }
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
    },
    {
      name: "get_draw_state",
      description: "Resolve the full GPU state for a draw/dispatch command: the bound pipeline " +
        "(and its vertex layout), bind groups per slot (with resource ids), vertex buffers per " +
        "slot (each with the command index that captured its bytes), the index buffer, and draw " +
        "params. Use this to diagnose what a specific draw actually read.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string", description: "Capture id (default: most recent)." },
          commandIndex: { type: "integer", description: "Index of a draw*/dispatch* command (see get_commands).", minimum: 0 }
        },
        required: ["commandIndex"]
      }
    },
    {
      name: "decode_vertex_buffer",
      description: "Decode the first N vertices of a captured vertex buffer into per-attribute " +
        "numbers, so you can read e.g. 'attribute @location(2) (uv) = (0,0)' directly. Pass the " +
        "bufferDataCommandIndex from get_draw_state (a setVertexBuffer command); the vertex layout " +
        "is taken from the draw's pipeline automatically (or pass `layout`/`pipelineId`).",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string", description: "Capture id (default: most recent)." },
          commandIndex: { type: "integer", description: "Index of the setVertexBuffer command (vertexBuffers[].bufferDataCommandIndex from get_draw_state).", minimum: 0 },
          firstN: { type: "integer", description: "Number of vertices to decode (default 8).", minimum: 1 },
          baseVertex: { type: "integer", description: "First vertex to decode from (default 0)." },
          pipelineId: { type: "integer", description: "Optional: pipeline object id to derive the layout from." },
          layout: {
            type: "object",
            description: "Optional explicit GPUVertexBufferLayout { arrayStride, attributes:[{shaderLocation, format, offset}] }."
          }
        },
        required: ["commandIndex"]
      }
    },
    {
      name: "diff_draws",
      description: "Structurally diff the resolved state (pipeline, bind groups, vertex/index " +
        "bindings, draw params) of two draw commands — useful when a working draw and a broken " +
        "draw share a pipeline and the difference must be in bound resources.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string", description: "Capture id (default: most recent)." },
          cmdA: { type: "integer", description: "Command index of the first draw.", minimum: 0 },
          cmdB: { type: "integer", description: "Command index of the second draw.", minimum: 0 }
        },
        required: ["cmdA", "cmdB"]
      }
    },
    {
      name: "read_buffer",
      description: "Read the current contents of a live GPU buffer on a connected page, without " +
        "taking a full capture. The inspector copies the buffer to a readback buffer, maps it, and " +
        "returns the bytes decoded as the requested type. The source buffer must have been created " +
        "with COPY_SRC usage (buffers created while a capture is armed are given COPY_SRC).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page to read from. Optional when exactly one page is connected." },
          bufferId: { type: "integer", description: "Numeric id of the GPU Buffer object to read." },
          offset: { type: "integer", description: "Byte offset to start reading at (default 0).", minimum: 0 },
          size: { type: "integer", description: "Number of bytes to read (default: to end of buffer, capped).", minimum: 1 },
          type: {
            type: "string",
            enum: ["uint8", "uint16", "uint32", "int32", "float32", "hex"],
            description: "How to decode the returned bytes (default float32)."
          }
        },
        required: ["bufferId"]
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
        maxBufferSize: args.maxBufferSize,
        maxTextureSize: args.maxTextureSize,
        passLabel: args.passLabel,
        passType: args.passType
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
      return {
        captureId: id,
        summary: summarize(json, {
          includeMethodCounts: args.includeMethodCounts,
          includeIssues: args.includeIssues
        })
      };
    },

    get_commands: async (args) => {
      const { id, json } = resolveCapture(args);
      return {
        captureId: id,
        ...listCommands(json, {
          offset: args.offset,
          limit: args.limit,
          method: args.method,
          passLabel: args.passLabel
        })
      };
    },

    get_draw_state: async (args) => {
      const { id, json } = resolveCapture(args);
      return { captureId: id, drawState: getDrawState(json, args.commandIndex | 0) };
    },

    decode_vertex_buffer: async (args) => {
      const { id, json } = resolveCapture(args);
      const resolver = (payloadId) => store.getPayload(id, payloadId);
      const decoded = decodeVertexBuffer(json, {
        commandIndex: args.commandIndex | 0,
        firstN: args.firstN,
        baseVertex: args.baseVertex,
        pipelineId: args.pipelineId,
        layout: args.layout
      }, resolver);
      return { captureId: id, ...decoded };
    },

    diff_draws: async (args) => {
      const { id, json } = resolveCapture(args);
      return { captureId: id, ...diffDraws(json, args.cmdA | 0, args.cmdB | 0) };
    },

    read_buffer: async (args) => {
      const result = await bridge.requestRead({
        pageId: args.pageId,
        bufferId: args.bufferId,
        offset: args.offset,
        size: args.size
      });
      return decodeReadback(result, args.type || "float32");
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
      const shader = getShader(json, args.objectId);
      if (typeof shader.code === "string" && shader.code.length > MAX_SHADER_CHARS) {
        shader.codeTruncated = { totalChars: shader.code.length, returnedChars: MAX_SHADER_CHARS };
        shader.code = shader.code.slice(0, MAX_SHADER_CHARS) + `\n...[truncated, ${shader.code.length - MAX_SHADER_CHARS} more chars]`;
      }
      return { captureId: id, ...shader };
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
      const clamped = typeof result === "string" ? result : clampResult(result);
      const text = typeof clamped === "string"
        ? clamped
        : JSON.stringify(clamped, null, 2);
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
