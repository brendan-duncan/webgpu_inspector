// Pure analysis helpers that operate on a WebGPU Inspector capture JSON
// object (the format produced by `saveCaptureData()` / the bridge upload, and
// by the DevTools "Save Capture" action).
//
// Everything here is read-only and must never echo raw base64 texture/buffer
// blobs back to the caller — captures are routinely multi-megabyte. Callers
// get summaries, counts, and decoded windows instead.

const DRAW_METHODS = new Set([
  "draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"
]);
const DISPATCH_METHODS = new Set([
  "dispatchWorkgroups", "dispatchWorkgroupsIndirect"
]);
const COPY_METHODS = new Set([
  "copyBufferToBuffer", "copyBufferToTexture",
  "copyTextureToBuffer", "copyTextureToTexture"
]);
const PIPELINE_CREATE_METHODS = new Set([
  "createRenderPipeline", "createComputePipeline",
  "createRenderPipelineAsync", "createComputePipelineAsync"
]);

// A payload reference is the lightweight stand-in (1.1 captures) for a byte blob
// that lives out-of-band, or the legacy (1.0) inline base64 marker.
function isPayloadRef(value) {
  return value && typeof value === "object" &&
    (typeof value.__payloadId === "number" || typeof value.__base64 === "string");
}

// Decode the bytes for a payload reference into a Buffer. `resolver` (optional)
// maps a payloadId to bytes (the capture store); inline base64 (legacy 1.0 or a
// raw payload line) is decoded directly. Returns null when unavailable.
export function resolvePayloadBytes(ref, resolver) {
  if (!ref) {
    return null;
  }
  if (typeof ref.__payloadId === "number" && typeof resolver === "function") {
    return resolver(ref.__payloadId);
  }
  const b64 = ref.base64 || ref.__base64;
  if (typeof b64 === "string") {
    return Buffer.from(b64, "base64");
  }
  return null;
}

// Compact, model-friendly view of a payload reference (no bytes).
function describePayloadRef(value, extra) {
  const out = Object.assign({
    __typedArray: value.__typedArray,
    __length: value.__length,
    byteLength: value.__byteLength ?? value.__length,
    __base64Omitted: true
  }, extra || {});
  if (typeof value.__payloadId === "number") {
    out.__payloadId = value.__payloadId;
  }
  if (value.__truncated) {
    out.truncated = value.__truncated;
  }
  return out;
}

// Recursively drop heavy byte payloads so analysis output stays small enough to
// hand back to the model. Buffer/texture bytes are replaced with a compact
// reference that still names the payload id (so accessors can fetch it lazily),
// its type, length, and any truncation.
export function stripHeavy(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripHeavy);
  }
  if (isPayloadRef(value)) {
    return describePayloadRef(value);
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === "mipData" && Array.isArray(value[key])) {
      out.mipData = value[key].map((m) => describePayloadRef(m || {}, { mipLevel: m && m.mipLevel }));
      continue;
    }
    if (key === "bufferData" && Array.isArray(value[key])) {
      out.bufferData = value[key].map((e) => describePayloadRef(e || {}, { entryIndex: e && e.entryIndex }));
      continue;
    }
    out[key] = stripHeavy(value[key]);
  }
  return out;
}

function objectsOf(capture) {
  return (capture && capture.objects) || {};
}

function commandsOf(capture) {
  return Array.isArray(capture && capture.commands) ? capture.commands : [];
}

function refId(value) {
  if (value && typeof value === "object" && typeof value.__id === "number") {
    return value.__id;
  }
  return null;
}

// A short, human-friendly label for an object id.
export function describeObject(capture, id) {
  const rec = objectsOf(capture)[String(id)];
  if (!rec) {
    return `#${id}`;
  }
  const label = rec.label ? ` "${rec.label}"` : "";
  return `${rec.type}#${id}${label}`;
}

// writeBuffer's data argument is serialized either as a `@id Ctor byteLength`
// string (large arrays) or an inline number array (small ones). Best-effort
// size extraction for statistics.
function writeBufferBytes(args) {
  if (!Array.isArray(args)) {
    return 0;
  }
  if (args.length > 4 && typeof args[4] === "number") {
    return args[4];
  }
  const data = args[2];
  if (typeof data === "string") {
    const parts = data.split(" ");
    const n = parseInt(parts[parts.length - 1], 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (data && typeof data === "object" && typeof data.__length === "number") {
    return data.__length;
  }
  if (Array.isArray(data)) {
    return data.length;
  }
  return 0;
}

// Build a compact summary of a capture: object/command counts, derived
// render statistics, validation errors, and heuristic issues. `options` can
// omit the heavier `methodCounts` map and `issues` list for a leaner result.
export function summarize(capture, options) {
  options = options || {};
  const objects = objectsOf(capture);
  const commands = commandsOf(capture);

  const objectCounts = {};
  let shaderModules = 0;
  let vertexShaders = 0;
  let fragmentShaders = 0;
  let computeShaders = 0;
  for (const id of Object.keys(objects)) {
    const rec = objects[id];
    if (!rec || !rec.type) {
      continue;
    }
    objectCounts[rec.type] = (objectCounts[rec.type] || 0) + 1;
    if (rec.type === "ShaderModule") {
      shaderModules++;
      if (rec.hasVertexEntries) vertexShaders++;
      if (rec.hasFragmentEntries) fragmentShaders++;
      if (rec.hasComputeEntries) computeShaders++;
    }
  }

  const methodCounts = {};
  let drawCalls = 0;
  let dispatches = 0;
  let renderPasses = 0;
  let computePasses = 0;
  let copies = 0;
  let writeBufferCalls = 0;
  let writeBufferBytesTotal = 0;
  let pipelineCreatesInFrame = 0;
  let shaderCreatesInFrame = 0;

  for (const cmd of commands) {
    if (!cmd || !cmd.method) {
      continue;
    }
    const m = cmd.method;
    methodCounts[m] = (methodCounts[m] || 0) + 1;
    if (DRAW_METHODS.has(m)) drawCalls++;
    else if (DISPATCH_METHODS.has(m)) dispatches++;
    else if (m === "beginRenderPass") renderPasses++;
    else if (m === "beginComputePass") computePasses++;
    else if (COPY_METHODS.has(m)) copies++;
    else if (m === "writeBuffer") {
      writeBufferCalls++;
      writeBufferBytesTotal += writeBufferBytes(cmd.args);
    }
    if (PIPELINE_CREATE_METHODS.has(m)) pipelineCreatesInFrame++;
    if (m === "createShaderModule") shaderCreatesInFrame++;
  }

  const validationErrors = Array.isArray(capture && capture.validationErrors)
    ? capture.validationErrors
    : [];

  const summary = {
    schemaVersion: capture && capture.schemaVersion,
    tool: capture && capture.tool,
    toolVersion: capture && capture.toolVersion,
    frame: (capture && capture.frame) || 0,
    exportedAt: capture && capture.exportedAt,
    totalCommands: commands.length,
    totalObjects: Object.keys(objects).length,
    objectCounts,
    stats: {
      drawCalls,
      dispatches,
      renderPasses,
      computePasses,
      copyCommands: copies,
      writeBufferCalls,
      writeBufferBytesTotal,
      setPipeline: methodCounts.setPipeline || 0,
      setBindGroup: methodCounts.setBindGroup || 0,
      setVertexBuffer: methodCounts.setVertexBuffer || 0,
      setIndexBuffer: methodCounts.setIndexBuffer || 0,
      pipelineCreatesInFrame,
      shaderCreatesInFrame
    },
    shaders: { shaderModules, vertexShaders, fragmentShaders, computeShaders },
    validationErrorCount: validationErrors.length
  };
  if (options.includeMethodCounts !== false) {
    summary.methodCounts = methodCounts;
  }
  if (options.includeIssues !== false) {
    summary.issues = findIssues(capture);
  }
  return summary;
}

// Heuristic problem detection. Each issue has a severity, a short message, and
// (where possible) command indices the caller can drill into with get_commands.
export function findIssues(capture) {
  const issues = [];
  const commands = commandsOf(capture);

  // Pipeline / shader creation inside a captured frame is a classic hitch.
  const pipelineCreates = [];
  const shaderCreates = [];
  for (let i = 0; i < commands.length; ++i) {
    const cmd = commands[i];
    if (!cmd || !cmd.method) {
      continue;
    }
    if (PIPELINE_CREATE_METHODS.has(cmd.method)) {
      pipelineCreates.push(i);
    }
    if (cmd.method === "createShaderModule") {
      shaderCreates.push(i);
    }
  }
  if (pipelineCreates.length) {
    issues.push({
      severity: "warning",
      code: "pipeline-create-in-frame",
      message: `${pipelineCreates.length} pipeline(s) created during the captured frame. ` +
        "Pipeline creation is expensive and can cause hitching; create pipelines at load time.",
      commandIndices: pipelineCreates.slice(0, 20)
    });
  }
  if (shaderCreates.length) {
    issues.push({
      severity: "info",
      code: "shader-create-in-frame",
      message: `${shaderCreates.length} shader module(s) created during the captured frame.`,
      commandIndices: shaderCreates.slice(0, 20)
    });
  }

  // Redundant consecutive setPipeline with the same pipeline.
  const redundantPipeline = [];
  const redundantBindGroup = [];
  let lastPipeline = null;
  const lastBindGroup = {};
  for (let i = 0; i < commands.length; ++i) {
    const cmd = commands[i];
    if (!cmd || !cmd.method) {
      continue;
    }
    if (cmd.method === "beginRenderPass" || cmd.method === "beginComputePass" ||
        cmd.method === "end") {
      lastPipeline = null;
      for (const k of Object.keys(lastBindGroup)) {
        delete lastBindGroup[k];
      }
      continue;
    }
    if (cmd.method === "setPipeline") {
      const id = refId(cmd.args && cmd.args[0]);
      if (id !== null && id === lastPipeline) {
        redundantPipeline.push(i);
      }
      lastPipeline = id;
    } else if (cmd.method === "setBindGroup") {
      const slot = cmd.args && cmd.args[0];
      const id = refId(cmd.args && cmd.args[1]);
      if (id !== null && lastBindGroup[slot] === id) {
        redundantBindGroup.push(i);
      }
      lastBindGroup[slot] = id;
    }
  }
  if (redundantPipeline.length) {
    issues.push({
      severity: "info",
      code: "redundant-set-pipeline",
      message: `${redundantPipeline.length} setPipeline call(s) re-bind the pipeline that ` +
        "was already active. Skipping them reduces CPU overhead.",
      commandIndices: redundantPipeline.slice(0, 20)
    });
  }
  if (redundantBindGroup.length) {
    issues.push({
      severity: "info",
      code: "redundant-set-bind-group",
      message: `${redundantBindGroup.length} setBindGroup call(s) re-bind a bind group that ` +
        "was already bound to that slot.",
      commandIndices: redundantBindGroup.slice(0, 20)
    });
  }

  // Validation errors are always worth surfacing.
  const validationErrors = Array.isArray(capture && capture.validationErrors)
    ? capture.validationErrors
    : [];
  if (validationErrors.length) {
    issues.push({
      severity: "error",
      code: "validation-errors",
      message: `${validationErrors.length} WebGPU validation error(s) were raised during capture.`,
      detail: validationErrors.slice(0, 5).map((e) => e && e.message)
    });
  }

  return issues;
}

// Paginated, base64-stripped command list, optionally filtered by method.
export function listCommands(capture, options) {
  options = options || {};
  const commands = commandsOf(capture);
  const method = options.method || null;
  const offset = Math.max(0, options.offset | 0);
  const limit = Math.min(500, Math.max(1, (options.limit | 0) || 50));
  let passLabelRegex = null;
  if (options.passLabel) {
    try {
      passLabelRegex = options.passLabel instanceof RegExp ? options.passLabel : new RegExp(options.passLabel);
    } catch (e) {
      passLabelRegex = null;
    }
  }

  let passDepth = 0;
  let passIndex = -1;
  let currentPassLabel = "";
  const filtered = [];
  for (let i = 0; i < commands.length; ++i) {
    const cmd = commands[i];
    if (!cmd) {
      continue;
    }
    if (cmd.method === "beginRenderPass" || cmd.method === "beginComputePass") {
      passIndex++;
      passDepth++;
      currentPassLabel = (cmd.args && cmd.args[0] && cmd.args[0].label) || "";
    }
    const entry = {
      index: i,
      method: cmd.method,
      pass: passDepth > 0 ? passIndex : null,
      object: cmd.object !== undefined ? stripHeavy(cmd.object) : undefined,
      args: cmd.args !== undefined ? stripHeavy(cmd.args) : undefined
    };
    if (cmd.result !== undefined) {
      entry.result = stripHeavy(cmd.result);
    }
    const labelForFilter = currentPassLabel;
    if (cmd.method === "end" && passDepth > 0) {
      passDepth--;
      if (passDepth === 0) {
        currentPassLabel = "";
      }
    }
    if (method && cmd.method !== method) {
      continue;
    }
    // Only commands inside a pass whose label matches survive the passLabel filter.
    if (passLabelRegex && !(entry.pass !== null && passLabelRegex.test(labelForFilter))) {
      continue;
    }
    filtered.push(entry);
  }

  return {
    total: filtered.length,
    offset,
    limit,
    commands: filtered.slice(offset, offset + limit)
  };
}

// One object record with descriptor, base64 stripped.
export function getObject(capture, id) {
  const rec = objectsOf(capture)[String(id)];
  if (!rec) {
    return null;
  }
  return stripHeavy(rec);
}

// WGSL source of a ShaderModule object, if present.
export function getShader(capture, id) {
  const rec = objectsOf(capture)[String(id)];
  if (!rec) {
    return { error: `No object #${id} in capture.` };
  }
  if (rec.type !== "ShaderModule") {
    return { error: `Object #${id} is a ${rec.type}, not a ShaderModule.` };
  }
  return {
    id: rec.id,
    label: rec.label || "",
    hasVertexEntries: !!rec.hasVertexEntries,
    hasFragmentEntries: !!rec.hasFragmentEntries,
    hasComputeEntries: !!rec.hasComputeEntries,
    code: (rec.descriptor && rec.descriptor.code) || ""
  };
}

// --- Per-draw resolved state (highest debugging value) ---------------------

const RENDER_STATE_METHODS = new Set([
  "setPipeline", "setBindGroup", "setVertexBuffer", "setIndexBuffer"
]);

// Resolve the GPU state in effect for the draw/dispatch at `commandIndex`: the
// bound pipeline (and its vertex layout), bind groups per slot, vertex buffers
// per slot (with the command index that captured each buffer's bytes), the
// index buffer, and the draw parameters. Built by walking the command list
// backward within the draw's enclosing pass — exactly the information needed to
// diagnose "this draw read a vertex attribute as 0".
export function getDrawState(capture, commandIndex) {
  const commands = commandsOf(capture);
  const draw = commands[commandIndex];
  if (!draw || !draw.method) {
    return { error: `No command at index ${commandIndex}.` };
  }
  const isDraw = DRAW_METHODS.has(draw.method);
  const isDispatch = DISPATCH_METHODS.has(draw.method);
  if (!isDraw && !isDispatch) {
    return { error: `Command #${commandIndex} is "${draw.method}", not a draw or dispatch. ` +
      "Pass the index of a draw*/dispatch* command (see get_commands)." };
  }

  const encoderId = draw.object;
  let pipeline = null;
  const bindGroups = {};
  const vertexBuffers = {};
  let indexBuffer = null;

  for (let i = commandIndex - 1; i >= 0; --i) {
    const c = commands[i];
    if (!c || !c.method) {
      continue;
    }
    if ((c.method === "beginRenderPass" || c.method === "beginComputePass") && c.result === encoderId) {
      break; // reached the start of this pass
    }
    if (c.object !== encoderId || !RENDER_STATE_METHODS.has(c.method)) {
      continue;
    }
    const a = c.args || [];
    if (c.method === "setPipeline") {
      if (pipeline === null) {
        pipeline = { commandIndex: i, id: refId(a[0]) };
      }
    } else if (c.method === "setBindGroup") {
      const slot = a[0];
      if (bindGroups[slot] === undefined) {
        bindGroups[slot] = {
          commandIndex: i,
          group: slot,
          bindGroupId: refId(a[1]),
          dynamicOffsets: a.length > 2 ? stripHeavy(a[2]) : undefined
        };
      }
    } else if (c.method === "setVertexBuffer") {
      const slot = a[0];
      if (vertexBuffers[slot] === undefined) {
        vertexBuffers[slot] = {
          slot,
          bufferDataCommandIndex: i,
          bufferId: refId(a[1]),
          offset: a[2] ?? 0,
          size: a[3] ?? null
        };
      }
    } else if (c.method === "setIndexBuffer") {
      if (indexBuffer === null) {
        indexBuffer = {
          commandIndex: i,
          bufferId: refId(a[0]),
          format: a[1],
          offset: a[2] ?? 0,
          size: a[3] ?? null
        };
      }
    }
  }

  const result = {
    commandIndex,
    method: draw.method,
    drawArgs: stripHeavy(draw.args),
    pipeline: null,
    bindGroups: Object.values(bindGroups).sort((x, y) => x.group - y.group),
    vertexBuffers: Object.values(vertexBuffers).sort((x, y) => x.slot - y.slot),
    indexBuffer
  };

  // Resolve the pipeline record + vertex layout, and attach the per-slot layout
  // to each bound vertex buffer so the layout travels with the binding.
  if (pipeline && pipeline.id != null) {
    const rec = objectsOf(capture)[String(pipeline.id)];
    const vbLayouts = (rec && rec.descriptor && rec.descriptor.vertex && rec.descriptor.vertex.buffers) || [];
    result.pipeline = {
      id: pipeline.id,
      label: (rec && rec.label) || "",
      setPipelineCommandIndex: pipeline.commandIndex,
      vertexBufferLayouts: vbLayouts
    };
    for (const vb of result.vertexBuffers) {
      const layout = vbLayouts[vb.slot];
      if (layout) {
        vb.layout = {
          arrayStride: layout.arrayStride,
          stepMode: layout.stepMode || "vertex",
          attributes: (layout.attributes || []).map((at) => ({
            shaderLocation: at.shaderLocation,
            format: at.format,
            offset: at.offset
          }))
        };
      }
    }
  }

  // Attach the bind group's descriptor entries (resource ids) for each binding.
  for (const bg of result.bindGroups) {
    if (bg.bindGroupId == null) {
      continue;
    }
    const rec = objectsOf(capture)[String(bg.bindGroupId)];
    if (rec && rec.descriptor) {
      bg.label = rec.label || "";
      bg.entries = stripHeavy(rec.descriptor.entries);
    }
  }

  return result;
}

// --- Vertex buffer decode --------------------------------------------------

// componentType drives how each scalar is read; size is bytes per component.
const VERTEX_FORMATS = {
  uint8: { t: "uint", n: 1, s: 1 }, sint8: { t: "sint", n: 1, s: 1 },
  unorm8: { t: "unorm", n: 1, s: 1 }, snorm8: { t: "snorm", n: 1, s: 1 },
  uint8x2: { t: "uint", n: 2, s: 1 }, uint8x4: { t: "uint", n: 4, s: 1 },
  sint8x2: { t: "sint", n: 2, s: 1 }, sint8x4: { t: "sint", n: 4, s: 1 },
  unorm8x2: { t: "unorm", n: 2, s: 1 }, unorm8x4: { t: "unorm", n: 4, s: 1 },
  snorm8x2: { t: "snorm", n: 2, s: 1 }, snorm8x4: { t: "snorm", n: 4, s: 1 },
  uint16: { t: "uint", n: 1, s: 2 }, sint16: { t: "sint", n: 1, s: 2 },
  unorm16: { t: "unorm", n: 1, s: 2 }, snorm16: { t: "snorm", n: 1, s: 2 },
  float16: { t: "float16", n: 1, s: 2 },
  uint16x2: { t: "uint", n: 2, s: 2 }, uint16x4: { t: "uint", n: 4, s: 2 },
  sint16x2: { t: "sint", n: 2, s: 2 }, sint16x4: { t: "sint", n: 4, s: 2 },
  unorm16x2: { t: "unorm", n: 2, s: 2 }, unorm16x4: { t: "unorm", n: 4, s: 2 },
  snorm16x2: { t: "snorm", n: 2, s: 2 }, snorm16x4: { t: "snorm", n: 4, s: 2 },
  float16x2: { t: "float16", n: 2, s: 2 }, float16x4: { t: "float16", n: 4, s: 2 },
  float32: { t: "float32", n: 1, s: 4 }, float32x2: { t: "float32", n: 2, s: 4 },
  float32x3: { t: "float32", n: 3, s: 4 }, float32x4: { t: "float32", n: 4, s: 4 },
  uint32: { t: "uint", n: 1, s: 4 }, uint32x2: { t: "uint", n: 2, s: 4 },
  uint32x3: { t: "uint", n: 3, s: 4 }, uint32x4: { t: "uint", n: 4, s: 4 },
  sint32: { t: "sint", n: 1, s: 4 }, sint32x2: { t: "sint", n: 2, s: 4 },
  sint32x3: { t: "sint", n: 3, s: 4 }, sint32x4: { t: "sint", n: 4, s: 4 },
  "unorm10-10-10-2": { t: "unorm10_10_10_2", n: 4, s: 4 }
};

function halfToFloat(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) {
    return sign * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 0x1f) {
    return frac ? NaN : sign * Infinity;
  }
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function readScalar(view, offset, type, size) {
  if (type === "float32") {
    return view.getFloat32(offset, true);
  }
  if (type === "float16") {
    return halfToFloat(view.getUint16(offset, true));
  }
  let raw;
  const signed = type === "sint" || type === "snorm";
  if (size === 1) {
    raw = signed ? view.getInt8(offset) : view.getUint8(offset);
  } else if (size === 2) {
    raw = signed ? view.getInt16(offset, true) : view.getUint16(offset, true);
  } else {
    raw = signed ? view.getInt32(offset, true) : view.getUint32(offset, true);
  }
  if (type === "unorm") {
    return raw / (Math.pow(2, size * 8) - 1);
  }
  if (type === "snorm") {
    return Math.max(raw / (Math.pow(2, size * 8 - 1) - 1), -1);
  }
  return raw; // uint / sint
}

// Decode `firstN` vertices of one vertex buffer into per-attribute numbers.
// `bytes` is the captured buffer slice (a Buffer/Uint8Array). `layout` is a
// GPUVertexBufferLayout ({ arrayStride, attributes:[{shaderLocation, format,
// offset}] }). The captured bytes begin at the setVertexBuffer offset, so
// indexing uses arrayStride from byte 0; `baseVertex` shifts the start.
export function decodeVertexBufferBytes(bytes, layout, firstN, baseVertex) {
  if (!bytes || !bytes.length) {
    return { error: "No captured bytes for this vertex buffer (it may have been outside the capture scope or dropped by the size cap)." };
  }
  if (!layout || !Array.isArray(layout.attributes)) {
    return { error: "A vertex buffer layout with attributes is required. Get it from get_draw_state (vertexBuffers[].layout)." };
  }
  const stride = layout.arrayStride || 0;
  if (!stride) {
    return { error: "Vertex layout arrayStride is 0; cannot index vertices." };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = (baseVertex | 0) * stride;
  const count = Math.max(0, firstN | 0) || 8;
  const vertices = [];
  let truncatedAt = null;
  for (let v = 0; v < count; ++v) {
    const vStart = base + v * stride;
    if (vStart + stride > bytes.length) {
      truncatedAt = v;
      break;
    }
    const attributes = {};
    for (const at of layout.attributes) {
      const fmt = VERTEX_FORMATS[at.format];
      if (!fmt) {
        attributes[at.shaderLocation] = { format: at.format, error: "unknown format" };
        continue;
      }
      const comps = [];
      let ok = true;
      for (let c = 0; c < fmt.n; ++c) {
        const off = vStart + (at.offset || 0) + c * fmt.s;
        if (off + fmt.s > bytes.length) {
          ok = false;
          break;
        }
        comps.push(readScalar(view, off, fmt.t, fmt.s));
      }
      attributes[at.shaderLocation] = ok
        ? { format: at.format, value: comps }
        : { format: at.format, error: "out of captured range" };
    }
    vertices.push({ vertex: (baseVertex | 0) + v, attributes });
  }
  return {
    arrayStride: stride,
    vertexCount: vertices.length,
    vertices,
    truncatedAt
  };
}

// Orchestrate a vertex-buffer decode from a setVertexBuffer command: locate the
// captured bytes (via `resolver`, which maps a payloadId to bytes), determine
// the vertex layout (explicit `params.layout`, or `params.pipelineId`, or by
// finding the next draw on the same encoder), and decode. This is what the
// `decode_vertex_buffer` MCP tool calls.
export function decodeVertexBuffer(capture, params, resolver) {
  const commands = commandsOf(capture);
  const commandIndex = params.commandIndex;
  const cmd = commands[commandIndex];
  if (!cmd) {
    return { error: `No command at index ${commandIndex}.` };
  }
  if (cmd.method !== "setVertexBuffer") {
    return { error: `Command #${commandIndex} is "${cmd.method}", not setVertexBuffer. ` +
      "Use get_draw_state and pass a vertex buffer's bufferDataCommandIndex." };
  }
  const slot = (cmd.args && cmd.args[0]) ?? 0;
  const entries = Array.isArray(cmd.bufferData) ? cmd.bufferData : [];
  const entry = entries.find((e) => e && e.entryIndex === slot) || entries[0];
  if (!entry) {
    return { error: "This setVertexBuffer command has no captured bytes (it was outside the " +
      "capture scope, or its buffer was dropped by the size cap)." };
  }
  const bytes = resolvePayloadBytes(entry, resolver);
  if (!bytes) {
    return { error: "Could not resolve the captured vertex bytes for this command." };
  }

  let layout = params.layout || null;
  if (!layout && params.pipelineId != null) {
    const rec = objectsOf(capture)[String(params.pipelineId)];
    const l = rec && rec.descriptor && rec.descriptor.vertex && rec.descriptor.vertex.buffers &&
      rec.descriptor.vertex.buffers[slot];
    if (l) {
      layout = { arrayStride: l.arrayStride, attributes: l.attributes };
    }
  }
  if (!layout) {
    // Find the next draw on the same encoder and borrow its resolved layout.
    const encoderId = cmd.object;
    for (let i = commandIndex + 1; i < commands.length; ++i) {
      const c = commands[i];
      if (!c) {
        continue;
      }
      if (c.object === encoderId && DRAW_METHODS.has(c.method)) {
        const ds = getDrawState(capture, i);
        const vb = ds.vertexBuffers && ds.vertexBuffers.find((v) => v.slot === slot);
        if (vb && vb.layout) {
          layout = vb.layout;
        }
        break;
      }
      if (c.method === "end" && c.object === encoderId) {
        break;
      }
    }
  }
  if (!layout) {
    return { error: "Could not determine the vertex layout. Pass `layout` (from get_draw_state) or `pipelineId`." };
  }

  const decoded = decodeVertexBufferBytes(bytes, layout, params.firstN, params.baseVertex);
  decoded.slot = slot;
  decoded.bufferId = refId(cmd.args && cmd.args[1]);
  const truncated = entry.__truncated || entry.truncated;
  if (truncated) {
    decoded.bufferTruncated = truncated;
  }
  return decoded;
}

// --- Diff two draws --------------------------------------------------------

// Structural diff of the resolved state of two draws (built on getDrawState).
export function diffDraws(capture, cmdA, cmdB) {
  const a = getDrawState(capture, cmdA);
  const b = getDrawState(capture, cmdB);
  if (a.error) {
    return { error: `Draw A: ${a.error}` };
  }
  if (b.error) {
    return { error: `Draw B: ${b.error}` };
  }

  const differences = [];
  const compare = (path, va, vb) => {
    const ja = JSON.stringify(va ?? null);
    const jb = JSON.stringify(vb ?? null);
    if (ja !== jb) {
      differences.push({ field: path, a: va ?? null, b: vb ?? null });
    }
  };

  compare("method", a.method, b.method);
  compare("pipeline.id", a.pipeline && a.pipeline.id, b.pipeline && b.pipeline.id);
  compare("drawArgs", a.drawArgs, b.drawArgs);
  compare("indexBuffer", a.indexBuffer, b.indexBuffer);

  const slots = new Set();
  const byGroup = (arr) => {
    const m = {};
    for (const bg of arr) { m[bg.group] = bg; slots.add(bg.group); }
    return m;
  };
  const aBG = byGroup(a.bindGroups);
  const bBG = byGroup(b.bindGroups);
  for (const g of [...slots].sort((x, y) => x - y)) {
    compare(`bindGroup[${g}].bindGroupId`, aBG[g] && aBG[g].bindGroupId, bBG[g] && bBG[g].bindGroupId);
    compare(`bindGroup[${g}].dynamicOffsets`, aBG[g] && aBG[g].dynamicOffsets, bBG[g] && bBG[g].dynamicOffsets);
  }

  const vbSlots = new Set();
  const bySlot = (arr) => {
    const m = {};
    for (const vb of arr) { m[vb.slot] = vb; vbSlots.add(vb.slot); }
    return m;
  };
  const aVB = bySlot(a.vertexBuffers);
  const bVB = bySlot(b.vertexBuffers);
  for (const s of [...vbSlots].sort((x, y) => x - y)) {
    compare(`vertexBuffer[${s}].bufferId`, aVB[s] && aVB[s].bufferId, bVB[s] && bVB[s].bufferId);
    compare(`vertexBuffer[${s}].offset`, aVB[s] && aVB[s].offset, bVB[s] && bVB[s].offset);
  }

  return { cmdA, cmdB, identical: differences.length === 0, differences };
}
