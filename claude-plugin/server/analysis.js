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

// Recursively drop heavy base64 payloads so analysis output stays small enough
// to hand back to the model.
export function stripHeavy(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripHeavy);
  }
  if (typeof value.__base64 === "string") {
    return {
      __typedArray: value.__typedArray,
      __length: value.__length,
      __base64Omitted: true
    };
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === "mipData" && Array.isArray(value[key])) {
      out.mipData = value[key].map((m) => ({
        mipLevel: m && m.mipLevel,
        byteLength: m && m.byteLength,
        base64Omitted: true
      }));
      continue;
    }
    if (key === "bufferData" && Array.isArray(value[key])) {
      out.bufferData = value[key].map((e) => ({
        entryIndex: e && e.entryIndex,
        byteLength: e && e.byteLength,
        base64Omitted: true
      }));
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
// render statistics, validation errors, and heuristic issues.
export function summarize(capture) {
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

  return {
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
    methodCounts,
    validationErrorCount: validationErrors.length,
    issues: findIssues(capture)
  };
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

  let passDepth = 0;
  let passIndex = -1;
  const filtered = [];
  for (let i = 0; i < commands.length; ++i) {
    const cmd = commands[i];
    if (!cmd) {
      continue;
    }
    if (cmd.method === "beginRenderPass" || cmd.method === "beginComputePass") {
      passIndex++;
      passDepth++;
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
    if (cmd.method === "end" && passDepth > 0) {
      passDepth--;
    }
    if (method && cmd.method !== method) {
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
