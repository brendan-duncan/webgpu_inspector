/**
 * The capture analyses of the Capture panel, without the panel.
 *
 * The Claude Code plugin's MCP server runs these in Node (the CPU analyses)
 * and in a replay tab of the browser it controls (the GPU replays), from one
 * bundle built into claude-plugin/server/lib. Everything returns plain JSON:
 * commands are named by their index in the capture's command list and
 * objects by id, so a result can go straight back to the model.
 *
 * DOM-free: nothing here may touch document or window.
 */
import { WgslDebug } from "wgsl_reflect/wgsl_reflect.module.js";
import { ObjectDatabase } from "./object_database.js";
import { importCaptureJson, parseCaptureText } from "./capture_import.js";
import { decodeCaptureBinary, isCaptureBinary } from "../utils/capture_binary.js";
import { analyzeRenderGraph, buildFrameRenderGraph } from "./render_graph.js";
import { analyzeFrameIssues } from "./frame_issues.js";
import { buildPixelHistoryPasses } from "./pixel_history_builder.js";
import { runPixelHistory } from "./pixel_history.js";
import { computeOverdrawSync } from "./overdraw.js";
import { replayOverdraw } from "./capture_replay.js";
import { getShaderCostTree } from "./shader_cost.js";
import { buildFrameCostTree, formatCostValue } from "./frame_cost_tree.js";
import { measureDrawTimings, detectTimingSupport } from "./draw_timing.js";
import { measureStatementCosts } from "./ablation_measure.js";
import { analyzePasses, collectPassStats, measurePasses } from "./bottleneck_report.js";
import { buildBindGroups, collectVertexBufferData, decodeIndexArray, makeVertexRunner } from "./stage_debug_utils.js";
import { fetchVertexInputs } from "./vertex_fetcher.js";
import { assembleTriangles, buildFragmentQuad } from "./fragment_debug.js";
import { cpuFragmentOutputs, outputsByKey } from "./shader_gpu_compare.js";

const DRAW_METHODS = new Set(["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
const DISPATCH_METHODS = new Set(["dispatchWorkgroups", "dispatchWorkgroupsIndirect"]);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a capture the way the Capture panel's Load Capture does.
 * @param {Object} data - the capture's metadata JSON
 * @param {{get:(id:number)=>Uint8Array|null}} [payloads] - payload bytes by id
 * @returns {Promise<Object>} a session for the functions below
 */
export async function openCapture(data, payloads) {
  const port = { addListener() {}, postMessage() {} };
  const database = new ObjectDatabase(port);
  const imported = await importCaptureJson(data, database, 0, payloads ?? new Map());
  const commands = imported.commands.filter((c) => c);
  // Imported views name their texture by id; resolve them all now, since the
  // shader debugger reads view.__texture directly.
  for (const object of database.capturedObjects.values()) {
    if (object.constructor?.className === "TextureView") {
      database.getTextureFromView(object);
    }
  }
  const getObject = (id) => (id === undefined || id === null ? null : database.getObject(id));
  const getTextureFromAttachment = (attachment) => {
    if (!attachment) {
      return null;
    }
    const ref = attachment.resolveTarget ?? attachment.view;
    if (ref?.__texture?.__id !== undefined) {
      return getObject(ref.__texture.__id);
    }
    const view = getObject(ref?.__id);
    return view ? database.getTextureFromView(view) : null;
  };
  return {
    data,
    database,
    commands,
    frame: imported.frame,
    getObject,
    getTextureFromAttachment,
    resolver: {
      getObject,
      getTextureFromView: (view) => database.getTextureFromView(view),
      getBundleCommands: (id) => getObject(id)?.commands ?? null,
    },
    cache: new Map(),
  };
}

/** Load a capture file's bytes: WGPUCAP binary, NDJSON or legacy JSON. */
export async function openCaptureBytes(bytes) {
  if (isCaptureBinary(bytes)) {
    const { metadata, payloads } = decodeCaptureBinary(bytes);
    return openCapture(metadata, payloads);
  }
  const { data, payloads } = parseCaptureText(new TextDecoder().decode(bytes));
  return openCapture(data, payloads);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function commandIndex(command) {
  return command && typeof command.id === "number" ? command.id : null;
}

function objectName(session, id) {
  const object = session.getObject(id);
  if (!object) {
    return `#${id}`;
  }
  const type = object.constructor?.className ?? object.constructor?.name ?? "Object";
  return object.label ? `${type}#${id} "${object.label}"` : `${type}#${id}`;
}

function round(value, digits = 3) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value ?? null;
  }
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function roundArray(values, digits = 4) {
  return Array.isArray(values) || ArrayBuffer.isView(values)
    ? Array.from(values, (v) => (typeof v === "number" ? round(v, digits) : v))
    : values;
}

// The texture a texture or texture-view id names.
function resolveTexture(session, id) {
  const object = session.getObject(id);
  if (!object) {
    throw new Error(`No object #${id} in the capture. The frame renders to: ${renderTargets(session).join("; ") || "nothing"}.`);
  }
  const type = object.constructor?.className;
  if (type === "TextureView") {
    const texture = session.database.getTextureFromView(object);
    if (!texture) {
      throw new Error(`TextureView #${id}'s texture is not in the capture.`);
    }
    return texture;
  }
  if (type !== "Texture") {
    throw new Error(`Object #${id} is a ${type}, not a Texture or TextureView.`);
  }
  return object;
}

// The textures the frame's render passes draw into, for "which texture?" errors.
function renderTargets(session) {
  const out = new Map();
  for (const command of session.commands) {
    if (command.method !== "beginRenderPass") {
      continue;
    }
    const desc = command.args?.[0] ?? {};
    for (const attachment of [...(desc.colorAttachments ?? []), desc.depthStencilAttachment]) {
      const texture = attachment ? session.getTextureFromAttachment(attachment) : null;
      if (texture && !out.has(texture.id)) {
        out.set(texture.id, `${objectName(session, texture.id)} ${texture.width}x${texture.height} ${texture.format}`);
      }
    }
  }
  return [...out.values()];
}

function commandAt(session, index) {
  const command = session.commands.find((c) => c.id === index);
  if (!command) {
    throw new Error(`No command ${index} in the capture.`);
  }
  return command;
}

// ---------------------------------------------------------------------------
// Render graph and frame issues
// ---------------------------------------------------------------------------

function renderGraph(session) {
  if (!session.cache.has("graph")) {
    session.cache.set("graph", buildFrameRenderGraph(session.commands, session.resolver));
  }
  return session.cache.get("graph");
}

/** The frame's passes in GPU order, the resources between them, and the graph's findings. */
export function getRenderGraph(session, { includeResources = true } = {}) {
  const graph = renderGraph(session);
  const use = (u) => {
    const out = { resource: u.resource.label, usage: u.usage };
    if (u.discards) {
      out.discards = true;
    }
    if (u.dropped) {
      out.overwrittenBeforeRead = true;
    }
    return out;
  };
  const { findings } = analyzeRenderGraph(graph);
  const result = {
    passes: graph.nodes.map((n) => ({
      ordinal: n.ordinal,
      kind: n.kind,
      label: n.label,
      commandIndex: commandIndex(n.command) ?? n.commandIndex ?? null,
      draws: n.draws,
      gpuMs: round(n.durationMs),
      reads: n.reads.map(use),
      writes: n.writes.map(use),
      dependsOn: [...new Set(n.inputs.map((e) => e.from.ordinal))],
      unread: n.unread || undefined,
    })),
    criticalPath: graph.criticalPath.map((n) => n.ordinal),
    criticalPathMs: round(graph.criticalPathMs),
    externalInputs: graph.externalInputs.map((r) => r.label),
    findings: findings.map((f) => ({
      rule: f.rule,
      severity: f.severity,
      confidence: f.confidence,
      message: f.message,
      passes: (f.nodes ?? (f.node ? [f.node] : [])).map((n) => n.ordinal),
    })),
    warnings: graph.warnings,
  };
  if (includeResources) {
    result.resources = graph.resources.map((r) => ({
      name: r.label,
      objectId: r.objectId,
      type: r.type,
      detail: r.detail,
      firstPass: Number.isFinite(r.first) ? r.first : null,
      lastPass: r.last >= 0 ? r.last : null,
      writes: r.versions.length - 1,
      sink: r.sink ?? undefined,
    }));
  }
  return result;
}

/** The Frame Issues report: performance and correctness rules over the frame. */
export function getFrameIssues(session, { severity, rule, limit = 100 } = {}) {
  const { findings } = analyzeFrameIssues(session.commands, session.resolver, { graph: renderGraph(session) });
  const order = ["high", "medium", "low", "info"];
  const minRank = severity ? order.indexOf(severity) : order.length;
  const filtered = findings.filter((f) =>
    (!rule || f.rule === rule) && (minRank < 0 || order.indexOf(f.severity) <= minRank));
  const counts = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return {
    total: findings.length,
    bySeverity: counts,
    rules: [...new Set(findings.map((f) => f.rule))],
    findings: filtered.slice(0, limit).map((f) => {
      const indices = (f.commands ?? (f.command ? [f.command] : [])).map(commandIndex).filter((i) => i !== null);
      return {
        rule: f.rule,
        severity: f.severity,
        confidence: f.confidence,
        message: f.message,
        count: f.count,
        commandIndices: indices.slice(0, 20),
        moreCommands: indices.length > 20 ? indices.length - 20 : undefined,
      };
    }),
    truncated: filtered.length > limit ? filtered.length - limit : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pixel history and overdraw (CPU)
// ---------------------------------------------------------------------------

function pixelPasses(session) {
  if (!session.cache.has("pixelPasses")) {
    session.cache.set("pixelPasses", buildPixelHistoryPasses(session.database, session.commands, session.getTextureFromAttachment));
  }
  return session.cache.get("pixelPasses");
}

/** Every event that touched one pixel of a texture during the frame. */
export function getPixelHistory(session, { textureId, x, y, limit = 200 }) {
  const texture = resolveTexture(session, textureId);
  if (x < 0 || y < 0 || x >= texture.width || y >= texture.height) {
    throw new Error(`(${x}, ${y}) is outside ${objectName(session, texture.id)} (${texture.width}x${texture.height}).`);
  }
  const built = pixelPasses(session);
  const { entries, finalValue } = runPixelHistory(built.passes, x, y, texture.id);
  const passName = (pass) => pass.label || `Render Pass ${pass.passIndex}`;
  const out = entries.map((e) => {
    const row = { type: e.type, pass: passName(e.pass), passCommandIndex: commandIndex(e.pass.command) };
    if (e.draw) {
      row.drawCommandIndex = commandIndex(e.draw.command);
    }
    if (e.type === "fragment") {
      row.status = e.status;
      row.primitive = e.primitive;
      if (e.instance) {
        row.instance = e.instance;
      }
      if (e.shaderOutput) {
        row.shaderOutput = roundArray(e.shaderOutput);
      }
      if (e.fragDepth !== undefined) {
        row.depth = round(e.fragDepth, 6);
      }
      if (e.depthBefore !== undefined && e.depthBefore !== null) {
        row.depthBefore = round(e.depthBefore, 6);
      }
      if (e.blended) {
        row.blended = true;
      }
      if (e.fsError) {
        row.error = e.fsError;
      }
    }
    if (e.message) {
      row.message = e.message;
    }
    if (e.value) {
      row.valueAfter = roundArray(e.value);
    }
    if (e.isDepth) {
      row.depthTarget = true;
    }
    return row;
  });
  const counts = {};
  for (const e of entries) {
    if (e.type === "fragment") {
      counts[e.status] = (counts[e.status] ?? 0) + 1;
    }
  }
  return {
    texture: `${objectName(session, texture.id)} ${texture.width}x${texture.height} ${texture.format}`,
    pixel: [x, y],
    finalValue: roundArray(finalValue),
    fragmentsByStatus: counts,
    entries: out.slice(0, limit),
    truncated: out.length > limit ? out.length - limit : undefined,
    notes: [...(built.notes ?? [])],
    method: "CPU simulation: the frame's vertex and fragment shaders are interpreted at this pixel.",
  };
}

// Summarize a per-pixel count grid: statistics, a histogram, the hottest
// region and a coarse text map.
function summarizeCounts(counts, width, height) {
  let covered = 0;
  let total = 0;
  let max = 0;
  const histogram = new Map();
  for (let i = 0; i < counts.length; ++i) {
    const c = counts[i];
    total += c;
    if (c > 0) {
      covered++;
    }
    if (c > max) {
      max = c;
    }
    const bucket = c >= 8 ? "8+" : String(c);
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
  }
  const cols = Math.min(48, width);
  const rows = Math.min(24, height);
  const ramp = " .:-=+*#%@";
  const map = [];
  let hottest = null;
  for (let r = 0; r < rows; ++r) {
    let line = "";
    const y0 = Math.floor(r * height / rows);
    const y1 = Math.max(y0 + 1, Math.floor((r + 1) * height / rows));
    for (let c = 0; c < cols; ++c) {
      const x0 = Math.floor(c * width / cols);
      const x1 = Math.max(x0 + 1, Math.floor((c + 1) * width / cols));
      let sum = 0;
      for (let y = y0; y < y1; ++y) {
        for (let x = x0; x < x1; ++x) {
          sum += counts[y * width + x];
        }
      }
      const mean = sum / ((y1 - y0) * (x1 - x0));
      if (!hottest || mean > hottest.meanOverdraw) {
        hottest = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, meanOverdraw: round(mean, 2) };
      }
      line += ramp[max > 0 ? Math.min(ramp.length - 1, Math.round(mean / max * (ramp.length - 1))) : 0];
    }
    map.push(line);
  }
  const order = ["0", "1", "2", "3", "4", "5", "6", "7", "8+"];
  return {
    pixels: width * height,
    fragments: total,
    maxOverdraw: max,
    meanOverdraw: round(total / Math.max(1, width * height), 3),
    meanOverdrawCovered: round(total / Math.max(1, covered), 3),
    coveredFraction: round(covered / Math.max(1, width * height), 4),
    histogram: Object.fromEntries(order.filter((k) => histogram.has(k)).map((k) => [k, histogram.get(k)])),
    hottestRegion: hottest,
    map,
    mapLegend: `${cols}x${rows} cells, " " = 0 up to "@" = ${max} fragments per pixel`,
  };
}

/** Overdraw of one render target by CPU simulation (see getOverdrawGpu). */
export function getOverdraw(session, { textureId }) {
  const texture = resolveTexture(session, textureId);
  const result = computeOverdrawSync(pixelPasses(session).passes, texture.id);
  return {
    texture: `${objectName(session, texture.id)} ${texture.width}x${texture.height} ${texture.format}`,
    method: "CPU rasterization of the frame's draws (every covered pixel, before depth and stencil tests)",
    ...summarizeCounts(result.counts, result.width, result.height),
    skippedDraws: result.skippedDraws || undefined,
    notes: result.notes,
  };
}

/** Overdraw of one render target by GPU replay. */
export async function getOverdrawGpu(session, device, { textureId }) {
  const texture = resolveTexture(session, textureId);
  const result = await replayOverdraw({
    device,
    database: session.database,
    commands: session.commands,
    targetTexture: texture,
    getTextureFromAttachment: session.getTextureFromAttachment,
  });
  if (!result || result.error || !result.counts) {
    throw new Error(result?.error ?? "The GPU replay produced no counts.");
  }
  return {
    texture: `${objectName(session, texture.id)} ${texture.width}x${texture.height} ${texture.format}`,
    method: "GPU replay of the frame's draws (every covered pixel, before depth and stencil tests)",
    ...summarizeCounts(result.counts, result.width, result.height),
    skippedDraws: result.skippedDraws || undefined,
    notes: result.notes,
  };
}

// ---------------------------------------------------------------------------
// Shader cost
// ---------------------------------------------------------------------------

// The hottest nodes of a cost tree, flattened: a flame graph as a list.
function hottest(root, units, limit, { maxDepth = 8 } = {}) {
  const out = [];
  const total = root.totalCost || 1;
  const walk = (node, path, depth) => {
    for (const child of node.children ?? []) {
      const entry = {
        name: child.name,
        kind: child.kind,
        cost: formatCostValue(child.totalCost, units),
        share: round(child.totalCost / total, 4),
        selfShare: round((child.selfCost ?? 0) / total, 4),
        path: path.length ? path.join(" > ") : undefined,
      };
      if (child.line > 0) {
        entry.lines = child.endLine > child.line ? `${child.line}-${child.endLine}` : `${child.line}`;
      }
      if (child.command) {
        entry.commandIndex = commandIndex(child.command);
      }
      if (child.module) {
        entry.shaderModuleId = child.module.id;
      }
      if (child.stage) {
        entry.stage = child.stage;
        entry.entryPoint = child.entryPoint;
      }
      if (child.estimated) {
        entry.estimated = true;
      }
      out.push(entry);
      if (depth < maxDepth) {
        walk(child, [...path, child.name], depth + 1);
      }
    }
  };
  walk(root, [], 0);
  out.sort((a, b) => b.share - a.share);
  return out.slice(0, limit);
}

/**
 * The shader flame graph. With shaderModuleId, one module's modeled cost by
 * entry point and statement; otherwise the frame's, by pass, draw group,
 * shader stage and statement (weighted by measured draw times when given).
 */
export function getShaderFlameGraph(session, { shaderModuleId, entryPoint, perDraw = false, limit = 40, drawTimings, fragmentCounts } = {}) {
  if (shaderModuleId !== undefined && shaderModuleId !== null) {
    const module = session.getObject(shaderModuleId);
    if (!module || module.constructor?.className !== "ShaderModule") {
      throw new Error(`Object #${shaderModuleId} is not a ShaderModule.`);
    }
    const tree = getShaderCostTree(module);
    const entries = entryPoint ? tree.entries.filter((e) => e.name === entryPoint) : tree.entries;
    if (!entries.length) {
      throw new Error(entryPoint ? `The shader has no entry point "${entryPoint}".` : "The shader has no entry points.");
    }
    return {
      shader: objectName(session, shaderModuleId),
      units: "modeled op units per invocation",
      entryPoints: entries.map((e) => ({
        name: e.name,
        stage: e.stage,
        costPerInvocation: formatCostValue(e.costPerInvocation ?? e.root.totalCost, "ops"),
        workgroupSize: e.workgroupSize ?? undefined,
        hottest: hottest(e.root, "ops", limit),
      })),
      warnings: tree.warnings,
    };
  }
  const result = buildFrameCostTree({
    commands: session.commands,
    getObject: session.getObject,
    perDraw,
    drawTimings,
    fragmentCounts,
  });
  return {
    units: result.units === "ms" ? "measured GPU ms (modeled split within each pass)" : "modeled op units (the capture has no pass timings)",
    total: formatCostValue(result.root.totalCost, result.units),
    passes: result.stats.passes,
    hottest: hottest(result.root, result.units, limit),
    warnings: result.warnings,
    timed: !!drawTimings,
  };
}

/** The frame flame graph with every draw's GPU time measured by replay. */
export async function getShaderFlameGraphTimed(session, device, options = {}) {
  const support = detectTimingSupport(device);
  if (!support.supported) {
    throw new Error(support.reason);
  }
  const timing = await measureDrawTimings({
    device,
    database: session.database,
    commands: session.commands,
    getTextureFromAttachment: session.getTextureFromAttachment,
  });
  const result = getShaderFlameGraph(session, { ...options, drawTimings: timing.timings });
  result.notes = [...(timing.notes ?? [])];
  if (timing.skipped) {
    result.notes.push(`${timing.skipped} draw(s) could not be replayed for timing and keep their modeled cost.`);
  }
  return result;
}

/**
 * Per-statement GPU cost of one draw's or dispatch's shader stage, measured by
 * replaying it with the shader cut short at each statement (ablation).
 */
export async function measureShaderCost(session, device, { commandIndex: index, stage, entryPoint }) {
  const command = commandAt(session, index);
  if (!DRAW_METHODS.has(command.method) && !DISPATCH_METHODS.has(command.method)) {
    throw new Error(`Command ${index} is a ${command.method}, not a draw or dispatch.`);
  }
  stage = stage ?? (DISPATCH_METHODS.has(command.method) ? "compute" : "fragment");
  const support = detectTimingSupport(device);
  if (!support.supported) {
    throw new Error(support.reason);
  }
  const result = await measureStatementCosts({
    device,
    database: session.database,
    commands: session.commands,
    getTextureFromAttachment: session.getTextureFromAttachment,
    drawCommand: command,
    stage,
    entryPoint,
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return {
    commandIndex: index,
    stage,
    totalMs: round(result.totalMs, 5),
    baselineMs: round(result.baselineMs, 5),
    repeats: result.repeats,
    statements: result.statements
      .map((s) => ({
        line: s.line,
        source: s.label,
        ms: s.ms === null ? null : round(s.ms, 5),
        perExecutionMs: s.perExecutionMs === undefined || s.perExecutionMs === null ? undefined : round(s.perExecutionMs, 7),
        depth: s.depth || undefined,
        tooSmall: (s.negative && s.depth === 0) || undefined,
      }))
      .sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity)),
    notes: result.notes ?? [],
  };
}

// ---------------------------------------------------------------------------
// GPU Bottlenecks
// ---------------------------------------------------------------------------

/** The GPU Bottlenecks report; fragment counts are measured when a device is given. */
export async function getBottlenecks(session, device) {
  const passes = collectPassStats(session.commands, { getObject: session.getObject, getTextureFromAttachment: session.getTextureFromAttachment });
  let notes = [];
  if (device) {
    notes = await measurePasses(passes, { device, database: session.database, getTextureFromAttachment: session.getTextureFromAttachment });
  } else {
    notes.push("Fragment counts need a GPU: run with a controlled browser (launch_browser) to measure rasterized and surviving fragments.");
  }
  const result = analyzePasses(passes);
  return {
    passes: result.passes.map((p) => ({
      label: p.label,
      kind: p.kind,
      commandIndex: commandIndex(p.begin),
      gpuMs: round(p.durationMs),
      share: round(p.share, 3),
      draws: p.kind === "render" ? p.draws : undefined,
      dispatches: p.kind === "compute" ? p.dispatches : undefined,
      primitives: p.kind === "render" ? p.primitives : undefined,
      primitivesExact: p.kind === "render" ? p.primitivesKnown : undefined,
      rasterized: p.rasterized,
      survived: p.survived,
      overdraw: round(p.overdraw, 2),
      pixelsPerPrimitive: round(p.fragsPerPrimitive, 2),
      rejected: round(p.rejected, 3),
      target: p.kind === "render" ? `${p.width}x${p.height}${p.sampleCount > 1 ? ` ${p.sampleCount}x MSAA` : ""} ${p.targets.join(", ")}` : undefined,
      verdict: p.verdict || undefined,
    })),
    findings: result.issues.map((f) => ({
      severity: f.severity,
      title: f.title,
      pass: f.pass.label,
      message: f.message,
    })),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Shader debugging (CPU)
// ---------------------------------------------------------------------------

// The pipeline, vertex/index buffers and bind groups in effect at a command.
function stateAt(session, command) {
  const list = session.commands;
  const idOf = (v) => (v && typeof v === "object" ? v.__id : v);
  const encoder = idOf(command.object);
  let pipeline = null;
  let indexBuffer = null;
  let pass = null;
  const vertexBuffers = [];
  const bindGroups = [];
  for (let i = list.indexOf(command) - 1; i >= 0; --i) {
    const c = list[i];
    if (idOf(c.object) !== encoder && idOf(c.result) !== encoder) {
      continue;
    }
    if (c.method === "beginRenderPass" || c.method === "beginComputePass") {
      pass = c;
      break;
    }
    if (c.method === "setPipeline" && !pipeline) {
      pipeline = c;
    } else if (c.method === "setIndexBuffer" && !indexBuffer) {
      indexBuffer = c;
    } else if (c.method === "setVertexBuffer" && !vertexBuffers[c.args[0]]) {
      vertexBuffers[c.args[0]] = c;
    } else if (c.method === "setBindGroup" && !bindGroups[c.args[0]]) {
      bindGroups[c.args[0]] = c;
    }
  }
  const pipelineObject = session.getObject(pipeline?.args?.[0]?.__id);
  return { pass, pipeline, pipelineObject, pipelineDesc: pipelineObject?.descriptor, indexBuffer, vertexBuffers, bindGroups };
}

function findEntry(reflection, stage, name) {
  const list = reflection?.entry?.[stage] ?? [];
  return (name ? list.find((e) => e.name === name) : null) ?? list[0] ?? null;
}

function jsValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return round(value, 6);
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Array.from(value, jsValue);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = jsValue(v);
    }
    return out;
  }
  return value;
}

function outputsJson(map) {
  const out = {};
  for (const [key, { name, value }] of map) {
    out[name && name !== key ? `${key} ${name}` : key] = jsValue(value);
  }
  return out;
}

// Step a debugger to completion, recording the watched variables whenever
// one of them changes.
function runWithTrace(debug, watch, maxSteps, maxTrace) {
  const trace = [];
  const last = new Map();
  let steps = 0;
  let more = true;
  while (more && steps < maxSteps) {
    more = debug.stepNext();
    steps++;
    if (!watch.length || trace.length >= maxTrace) {
      continue;
    }
    const changed = {};
    let any = false;
    for (const name of watch) {
      let value;
      try {
        value = debug.getVariableValue(name);
      } catch (_) {
        value = null;
      }
      const text = JSON.stringify(jsValue(value));
      if (value !== null && value !== undefined && last.get(name) !== text) {
        last.set(name, text);
        changed[name] = jsValue(value);
        any = true;
      }
    }
    if (any) {
      trace.push({ line: debug.currentLine, ...changed });
    }
  }
  return { steps, finished: !more, trace, traceTruncated: trace.length >= maxTrace || undefined };
}

/**
 * Run one shader invocation of a draw or dispatch on the CPU interpreter:
 * its inputs, its outputs, and a trace of the watched variables.
 *   vertex:   vertexIndex (+ instance)
 *   fragment: pixel x, y (+ instance, primitive)
 *   compute:  invocation [x, y, z] (global invocation id)
 */
export function debugShader(session, params) {
  const command = commandAt(session, params.commandIndex);
  const isDraw = DRAW_METHODS.has(command.method);
  const isDispatch = DISPATCH_METHODS.has(command.method);
  if (!isDraw && !isDispatch) {
    throw new Error(`Command ${params.commandIndex} is a ${command.method}, not a draw or dispatch.`);
  }
  const state = stateAt(session, command);
  const desc = state.pipelineDesc;
  if (!desc) {
    throw new Error("The command's pipeline is not in the capture.");
  }
  const bindGroups = buildBindGroups(session.database, state.bindGroups);
  const missing = missingBindingData(session, state.bindGroups);
  try {
    return runDebugShader(session, params, command, isDispatch, state, desc, bindGroups, missing);
  } catch (e) {
    if (missing.length) {
      e.message = `${e.message} (${missingNote(missing)})`;
    }
    throw e;
  }
}

// The bound resources whose contents the capture doesn't have: buffers
// captured with payloads off or truncated, and textures without pixel data.
function missingBindingData(session, bindGroupCommands) {
  const missing = [];
  for (const command of bindGroupCommands) {
    if (!command) {
      continue;
    }
    const group = command.args[0];
    const bindGroup = session.getObject(command.args[1]?.__id);
    (bindGroup?.descriptor?.entries ?? []).forEach((entry, i) => {
      const resource = entry.resource;
      const object = session.getObject(resource?.__id ?? resource?.buffer?.__id);
      const type = object?.constructor?.className;
      if (resource?.buffer || type === "Buffer") {
        const data = command.bufferData?.[i];
        if (!data || !data.byteLength) {
          missing.push(`@group(${group}) @binding(${entry.binding}) buffer ${objectName(session, resource.buffer?.__id ?? resource.__id)}`);
        }
      } else if (type === "TextureView") {
        const texture = session.database.getTextureFromView(object);
        if (!texture?.imageData?.[0]) {
          missing.push(`@group(${group}) @binding(${entry.binding}) texture ${objectName(session, texture?.id ?? resource.__id)}`);
        }
      }
    });
  }
  return missing;
}

function missingNote(missing) {
  return `the capture has no data for ${missing.join(", ")}; capture with payloads "all" to debug with real resource contents`;
}

function runDebugShader(session, params, command, isDispatch, state, desc, bindGroups, missing) {
  const stage = params.stage ?? (isDispatch ? "compute" : (params.x !== undefined ? "fragment" : "vertex"));
  const watch = params.watch ?? [];
  const maxSteps = params.maxSteps ?? 2_000_000;
  const maxTrace = params.maxTrace ?? 200;
  const stageDesc = stage === "compute" ? desc.compute : stage === "vertex" ? desc.vertex : desc.fragment;
  const module = session.getObject(stageDesc?.module?.__id);
  if (!module) {
    throw new Error(`The pipeline's ${stage} shader is not in the capture.`);
  }
  const entry = findEntry(module.reflection, stage, stageDesc.entryPoint);
  if (!entry) {
    throw new Error(`The ${stage} shader has no ${stage} entry point.`);
  }
  const code = module.descriptor.code;
  const constants = stageDesc.constants;
  const options = constants ? { constants } : {};
  const result = { commandIndex: params.commandIndex, stage, shaderModuleId: module.id, entryPoint: entry.name };
  if (missing.length) {
    result.missingData = missingNote(missing);
  }

  if (stage === "compute") {
    const arg = command.args?.[0];
    if (command.method !== "dispatchWorkgroups") {
      throw new Error("Indirect dispatches can't be debugged: their workgroup counts are in a GPU buffer.");
    }
    const count = Array.isArray(arg) ? [arg[0] ?? 1, arg[1] ?? 1, arg[2] ?? 1] : [arg ?? 1, command.args?.[1] ?? 1, command.args?.[2] ?? 1];
    const id = params.invocation ?? [0, 0, 0];
    const debug = new WgslDebug(code);
    if (!debug.debugWorkgroup(entry.name, id, count, bindGroups, options)) {
      throw new Error("The compute shader could not be started on the CPU.");
    }
    Object.assign(result, { invocation: id, dispatch: count }, runWithTrace(debug, watch, maxSteps, maxTrace));
    return result;
  }

  const vertexBufferData = collectVertexBufferData(state.vertexBuffers);
  const instance = params.instance ?? 0;
  if (stage === "vertex") {
    const vertexIndex = params.vertexIndex ?? 0;
    const inputs = fetchVertexInputs(desc, vertexBufferData, vertexIndex, instance, entry.inputs);
    const debug = new WgslDebug(code);
    if (!debug.debugVertex(entry.name, inputs, bindGroups, options)) {
      throw new Error("The vertex shader could not be started on the CPU.");
    }
    const run = runWithTrace(debug, watch, maxSteps, maxTrace);
    Object.assign(result, {
      vertexIndex,
      instance,
      inputs: jsValue(inputs),
      outputs: run.finished ? outputsJson(outputsByKey(debug.getReturnValue(), entry.outputs)) : null,
      ...run,
    });
    return result;
  }

  // Fragment: rasterize the draw at the pixel and run the 2x2 quad.
  if (params.x === undefined || params.y === undefined) {
    throw new Error("Fragment debugging needs a pixel: x and y.");
  }
  const vsModule = session.getObject(desc.vertex?.module?.__id);
  const vsEntry = findEntry(vsModule?.reflection, "vertex", desc.vertex?.entryPoint);
  if (!vsEntry) {
    throw new Error("The draw's vertex shader is not in the capture.");
  }
  const args = command.args ?? [];
  const topology = desc.primitive?.topology ?? "triangle-list";
  let triangles;
  if (command.method === "drawIndexed") {
    const indexArray = decodeIndexArray(state.indexBuffer);
    if (!indexArray) {
      throw new Error("The draw's index buffer data was not captured.");
    }
    triangles = assembleTriangles(topology, args[0], indexArray, args[2] ?? 0, args[3] ?? 0);
  } else if (command.method === "draw") {
    triangles = assembleTriangles(topology, args[0], null, args[2] ?? 0, 0);
  } else {
    throw new Error("Indirect draws can't be debugged per fragment: their arguments are in a GPU buffer.");
  }
  const attachment = state.pass?.args?.[0]?.colorAttachments?.[0] ?? state.pass?.args?.[0]?.depthStencilAttachment;
  const target = attachment ? session.getTextureFromAttachment(attachment) : null;
  if (!target) {
    throw new Error("The draw's render target is not in the capture.");
  }
  const runVertex = makeVertexRunner({
    code: vsModule.descriptor.code,
    entryName: vsEntry.name,
    entryInputs: vsEntry.inputs,
    entryOutputs: vsEntry.outputs,
    pipelineDesc: desc,
    vertexBufferData,
    bindGroups,
    constants: desc.vertex?.constants,
  });
  const x = Math.floor(params.x);
  const y = Math.floor(params.y);
  const quad = buildFragmentQuad(triangles, (v) => runVertex(v, instance), target.width, target.height,
    x, y, desc.primitive?.frontFace ?? "ccw", params.primitive ?? -1);
  if (!quad) {
    throw new Error(`No primitive of the draw covers pixel (${x}, ${y}).`);
  }
  const fragment = cpuFragmentOutputs({ code, entry, quadInputs: quad.quadInputs, bindGroups, targetLane: quad.targetLane, constants });
  Object.assign(result, {
    pixel: [x, y],
    instance,
    inputs: jsValue(quad.quadInputs[quad.targetLane]),
    discarded: fragment.discarded,
    outputs: fragment.discarded ? null : outputsJson(fragment.outputs),
  });
  if (watch.length) {
    // The trace runs the picked lane alone, so derivatives (dpdx, fwidth,
    // implicit-LOD sampling) read as zero in it; the outputs above come from
    // the full quad.
    const debug = new WgslDebug(code);
    if (debug.debugFragment(entry.name, quad.quadInputs[quad.targetLane], bindGroups, options)) {
      const run = runWithTrace(debug, watch, maxSteps, maxTrace);
      result.trace = run.trace;
      result.traceNote = "The trace runs this pixel alone, so derivatives read as 0 in it; outputs come from the full 2x2 quad.";
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Comparing captures
// ---------------------------------------------------------------------------

function captureProfile(session) {
  const methods = {};
  for (const c of session.commands) {
    methods[c.method] = (methods[c.method] ?? 0) + 1;
  }
  const objects = {};
  const shaders = new Map();
  for (const object of session.database.capturedObjects.values()) {
    const type = object.constructor?.className ?? "Object";
    objects[type] = (objects[type] ?? 0) + 1;
    if (type === "ShaderModule") {
      shaders.set(object.label || `#${object.id}`, object.descriptor?.code ?? "");
    }
  }
  const graph = renderGraph(session);
  const passes = graph.nodes.map((n) => ({ kind: n.kind, label: n.label, draws: n.draws, gpuMs: n.durationMs }));
  const gpuMs = passes.reduce((s, p) => s + (p.gpuMs ?? 0), 0);
  const issues = analyzeFrameIssues(session.commands, session.resolver, { graph }).findings;
  return { methods, objects, shaders, passes, gpuMs, timed: passes.some((p) => p.gpuMs !== null), issues };
}

function diffCounts(a, b) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) {
      out[key] = { a: a[key] ?? 0, b: b[key] ?? 0, delta: (b[key] ?? 0) - (a[key] ?? 0) };
    }
  }
  return out;
}

/** What changed between two captures: work, passes, GPU time, shaders and issues. */
export function compareCaptures(sessionA, sessionB) {
  const a = captureProfile(sessionA);
  const b = captureProfile(sessionB);
  // Match passes by label, then by position among the unlabeled.
  const key = (p, i, list) => p.label ? `${p.kind}:${p.label}#${list.slice(0, i).filter((q) => q.label === p.label).length}` : `${p.kind}@${i}`;
  const mapA = new Map(a.passes.map((p, i) => [key(p, i, a.passes), p]));
  const mapB = new Map(b.passes.map((p, i) => [key(p, i, b.passes), p]));
  const passes = [];
  for (const k of new Set([...mapA.keys(), ...mapB.keys()])) {
    const pa = mapA.get(k);
    const pb = mapB.get(k);
    const row = { pass: (pa ?? pb).label || k, kind: (pa ?? pb).kind };
    if (!pa) {
      row.change = "added";
    } else if (!pb) {
      row.change = "removed";
    }
    if (pa && pb && pa.draws !== pb.draws) {
      row.draws = { a: pa.draws, b: pb.draws };
    }
    if (pa?.gpuMs !== null && pb?.gpuMs !== null && pa && pb) {
      const delta = pb.gpuMs - pa.gpuMs;
      if (Math.abs(delta) >= 0.01) {
        row.gpuMs = { a: round(pa.gpuMs), b: round(pb.gpuMs), delta: round(delta) };
      }
    }
    if (Object.keys(row).length > 2) {
      passes.push(row);
    }
  }
  passes.sort((x, y) => Math.abs(y.gpuMs?.delta ?? 0) - Math.abs(x.gpuMs?.delta ?? 0));
  const shaderChanges = [];
  for (const name of new Set([...a.shaders.keys(), ...b.shaders.keys()])) {
    const ca = a.shaders.get(name);
    const cb = b.shaders.get(name);
    if (ca === undefined) {
      shaderChanges.push({ shader: name, change: "added" });
    } else if (cb === undefined) {
      shaderChanges.push({ shader: name, change: "removed" });
    } else if (ca !== cb) {
      shaderChanges.push({ shader: name, change: "code changed", linesA: ca.split("\n").length, linesB: cb.split("\n").length });
    }
  }
  const ruleCounts = (issues) => {
    const out = {};
    for (const f of issues) {
      out[f.rule] = (out[f.rule] ?? 0) + (f.count ?? 1);
    }
    return out;
  };
  return {
    gpuMs: a.timed && b.timed ? { a: round(a.gpuMs), b: round(b.gpuMs), delta: round(b.gpuMs - a.gpuMs) } : "not compared: both captures need pass timings (profilePasses)",
    passCount: { a: a.passes.length, b: b.passes.length },
    passChanges: passes.slice(0, 50),
    commandChanges: diffCounts(a.methods, b.methods),
    objectChanges: diffCounts(a.objects, b.objects),
    shaderChanges: shaderChanges.slice(0, 50),
    issueChanges: diffCounts(ruleCounts(a.issues), ruleCounts(b.issues)),
    note: "Shaders are matched by label (or id when unlabeled), passes by label and order.",
  };
}
