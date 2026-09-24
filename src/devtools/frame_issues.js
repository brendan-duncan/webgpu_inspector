import { analyzeRenderGraph, buildFrameRenderGraph, executionOrder } from "./render_graph.js";
import { workgroupSizeFor } from "./shader_invocations.js";

/**
 * Frame-level issues in a capture: rules over the captured commands, the
 * counterpart of the per-shader rules in shader_analysis_view.js.
 *
 *   pipeline-created-in-frame  a synchronous createRenderPipeline/createComputePipeline mid-frame
 *   shader-created-in-frame    createShaderModule mid-frame
 *   resource-created-in-frame  createBuffer / createTexture mid-frame
 *   bind-group-created-in-frame  createBindGroup mid-frame (many per frame)
 *   fragmented-buffer-writes   many queue.writeBuffer calls to one buffer
 *   many-submits               many queue.submit calls in one frame
 *   canvas-load                loadOp "load" on a freshly acquired canvas texture
 *   color-load                 loadOp "load" of an attachment nothing in the frame rendered yet
 *   empty-pass                 a pass that draws, dispatches and clears nothing
 *   redundant-pipeline-bind    setPipeline with the pipeline already bound
 *   redundant-bind-group       setBindGroup with the group (and offsets) already bound
 *   redundant-buffer-bind      setVertexBuffer / setIndexBuffer with what is already bound
 *   redundant-state            setViewport / setScissorRect / setBlendConstant /
 *                              setStencilReference with the current values
 *   tiny-draws                 many non-instanced draws of a handful of vertices
 *   small-dispatch             a dispatch with fewer invocations than one GPU wave
 *
 * plus the dependency rules of the render graph (render_graph.js), which
 * answer exactly questions like "does anything read this attachment?".
 *
 * Every finding names the commands it is about, so the UI can jump to them
 * and mark them in the command list. The module is free of DOM dependencies
 * so it can be unit tested and used outside DevTools.
 */

const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };

const DRAW_METHODS = new Set(["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
const DISPATCH_METHODS = new Set(["dispatchWorkgroups", "dispatchWorkgroupsIndirect"]);

const TINY_DRAW_VERTICES = 12;
const TINY_DRAW_COUNT = 32;
// Invocations below which a dispatch can't fill even one wave of a small GPU.
const SMALL_DISPATCH_INVOCATIONS = 64;
const FRAGMENTED_WRITE_COUNT = 8;
const MANY_SUBMITS = 4;
const BIND_GROUP_CREATE_COUNT = 16;
const MAX_FINDING_COMMANDS = 256;

/** One finding per rule, naming the first case and keeping the rest. */
class Folded {
  constructor() {
    this.commands = [];
    this.count = 0;
    this.subjects = [];
  }

  add(command, subject) {
    this.count++;
    if (this.commands.length < MAX_FINDING_COMMANDS && !this.commands.includes(command)) {
      this.commands.push(command);
    }
    if (subject && this.subjects.length < 3 && !this.subjects.includes(subject)) {
      this.subjects.push(subject);
    }
  }

  get subjectText() {
    const names = this.subjects.join(", ");
    const rest = this.count - this.subjects.length;
    return rest > 0 && this.subjects.length ? `${names} and ${rest} more` : names;
  }
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

function times(folded) {
  return folded.count === 1 ? "once" : `${folded.count} times`;
}

function sameArgs(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * @param {Object[]} commands - the capture's flat command list
 * @param {Object} resolver - { getObject, getTextureFromView?, getBundleCommands? }
 *   (the same resolver buildFrameRenderGraph takes)
 * @param {Object} [options]
 * @param {Object} [options.graph] - a render graph already built for these commands
 * @returns {{findings: Object[], byCommand: Map<Object, Object[]>}} findings are
 *   { rule, severity, confidence, message, command, commands, count }, most severe first.
 */
export function analyzeFrameIssues(commands, resolver, options = {}) {
  const findings = [];
  const getObject = (id) => (id === undefined || id === null ? null : resolver.getObject(id));
  const nameOf = (ref, fallback) => {
    const object = getObject(ref?.__id);
    return object?.label ? `"${object.label}"` : `${fallback} ${ref?.__id ?? "?"}`;
  };

  const add = (rule, severity, confidence, message, folded) => {
    findings.push({ rule, severity, confidence, message, command: folded.commands[0] ?? null, commands: folded.commands, count: folded.count });
  };

  // ------------------------------------------------ objects created mid-frame
  {
    const pipelines = new Folded();
    const shaders = new Folded();
    const resources = new Folded();
    const bindGroups = new Folded();
    for (const command of commands) {
      if (!command) {
        continue;
      }
      const method = command.method;
      if (method === "createRenderPipeline" || method === "createComputePipeline") {
        pipelines.add(command, command.args?.[0]?.label ? `"${command.args[0].label}"` : null);
      } else if (method === "createShaderModule") {
        shaders.add(command, command.args?.[0]?.label ? `"${command.args[0].label}"` : null);
      } else if (method === "createBuffer" || method === "createTexture") {
        resources.add(command, command.args?.[0]?.label ? `"${command.args[0].label}"` : null);
      } else if (method === "createBindGroup") {
        bindGroups.add(command, null);
      }
    }
    if (pipelines.count) {
      add("pipeline-created-in-frame", "high", "high",
        `${plural(pipelines.count, "pipeline")} ${pipelines.count === 1 ? "is" : "are"} created with the synchronous createRenderPipeline/createComputePipeline during the frame${pipelines.subjects.length ? ` (${pipelines.subjectText})` : ""}. ` +
        `Compiling a pipeline can take tens of milliseconds and blocks the frame until it is done. Create pipelines at load time, or with createRenderPipelineAsync/createComputePipelineAsync so the compile happens off the frame.`, pipelines);
    }
    if (shaders.count) {
      add("shader-created-in-frame", "medium", "high",
        `${plural(shaders.count, "shader module")} ${shaders.count === 1 ? "is" : "are"} created during the frame${shaders.subjects.length ? ` (${shaders.subjectText})` : ""}. ` +
        `Shader parsing and validation cost CPU time on every creation; create modules once and reuse them.`, shaders);
    }
    if (resources.count) {
      add("resource-created-in-frame", "medium", "medium",
        `${plural(resources.count, "buffer or texture", "buffers and textures")} ${resources.count === 1 ? "is" : "are"} created during the frame${resources.subjects.length ? ` (${resources.subjectText})` : ""}. ` +
        `Allocating GPU memory every frame costs driver time and churns memory; keep long-lived resources, or pool and reuse transient ones. A capture of a frame that loads new content will show this legitimately.`, resources);
    }
    if (bindGroups.count >= BIND_GROUP_CREATE_COUNT) {
      add("bind-group-created-in-frame", "low", "medium",
        `${plural(bindGroups.count, "bind group")} ${bindGroups.count === 1 ? "is" : "are"} created during the frame. ` +
        `Each createBindGroup is validated and allocated by the implementation; bind groups whose resources don't change can be created once and cached, and per-draw data can go through dynamic offsets into one buffer.`, bindGroups);
    }
  }

  // ------------------------------------------------------------ queue usage
  {
    const writesByBuffer = new Map();
    const submits = new Folded();
    for (const command of commands) {
      if (!command) {
        continue;
      }
      if (command.method === "writeBuffer") {
        const id = command.args?.[0]?.__id;
        if (id === undefined) {
          continue;
        }
        let list = writesByBuffer.get(id);
        if (!list) {
          list = [];
          writesByBuffer.set(id, list);
        }
        list.push(command);
      } else if (command.method === "submit") {
        submits.add(command, null);
      }
    }
    const fragmented = new Folded();
    let buffers = 0;
    for (const [id, list] of writesByBuffer) {
      if (list.length < FRAGMENTED_WRITE_COUNT) {
        continue;
      }
      buffers++;
      for (const command of list) {
        fragmented.add(command, null);
      }
      if (fragmented.subjects.length < 3) {
        fragmented.subjects.push(`${nameOf({ __id: id }, "Buffer")} (${list.length} writes)`);
      }
    }
    if (buffers) {
      add("fragmented-buffer-writes", "low", "high",
        `${plural(buffers, "buffer")} ${buffers === 1 ? "is" : "are"} updated with ${FRAGMENTED_WRITE_COUNT} or more separate queue.writeBuffer calls in the frame: ${fragmented.subjects.join(", ")}${buffers > fragmented.subjects.length ? ` and ${buffers - fragmented.subjects.length} more` : ""}. ` +
        `Each call has its own overhead and staging copy. Gather the data in one CPU-side array and write it with one call per buffer (per contiguous range).`, fragmented);
    }
    if (submits.count > MANY_SUBMITS) {
      add("many-submits", "low", "medium",
        `queue.submit is called ${submits.count} times in the frame. Each submit has a fixed CPU and driver cost; encoding the frame's work into fewer command buffers and submitting them together (submit takes an array) is cheaper.`, submits);
    }
  }

  // ------------------------------------------------------ per-pass state walk
  {
    const redundantPipeline = new Folded();
    const redundantBindGroup = new Folded();
    const redundantBuffer = new Folded();
    const redundantState = new Folded();
    const tinyDraws = new Folded();
    const smallDispatch = new Folded();
    const emptyPasses = new Folded();
    let drawCount = 0;

    let pass = null;
    const newState = () => ({ pipeline: undefined, bindGroups: new Map(), vertexBuffers: new Map(), indexBuffer: undefined, dynamic: new Map() });

    const walk = (command, state) => {
      const method = command.method;
      const args = command.args ?? [];
      if (method === "setPipeline") {
        if (state.pipeline !== undefined && state.pipeline === args[0]?.__id) {
          redundantPipeline.add(command, null);
        }
        state.pipeline = args[0]?.__id;
      } else if (method === "setBindGroup") {
        const bound = state.bindGroups.get(args[0]);
        const value = { id: args[1]?.__id, offsets: args.slice(2) };
        if (bound && bound.id === value.id && sameArgs(bound.offsets, value.offsets)) {
          redundantBindGroup.add(command, null);
        }
        state.bindGroups.set(args[0], value);
      } else if (method === "setVertexBuffer") {
        const bound = state.vertexBuffers.get(args[0]);
        const value = args.slice(1);
        if (bound && sameArgs(bound, value)) {
          redundantBuffer.add(command, null);
        }
        state.vertexBuffers.set(args[0], value);
      } else if (method === "setIndexBuffer") {
        if (state.indexBuffer && sameArgs(state.indexBuffer, args)) {
          redundantBuffer.add(command, null);
        }
        state.indexBuffer = args;
      } else if (method === "setViewport" || method === "setScissorRect" || method === "setBlendConstant" || method === "setStencilReference") {
        const bound = state.dynamic.get(method);
        if (bound && sameArgs(bound, args)) {
          redundantState.add(command, method);
        }
        state.dynamic.set(method, args);
      } else if (DRAW_METHODS.has(method)) {
        drawCount++;
        pass.work++;
        const instances = args[1] ?? 1;
        if ((method === "draw" || method === "drawIndexed") && instances === 1 &&
            typeof args[0] === "number" && args[0] <= TINY_DRAW_VERTICES) {
          tinyDraws.add(command, null);
        }
      } else if (DISPATCH_METHODS.has(method)) {
        pass.work++;
        if (method === "dispatchWorkgroups") {
          const groups = (args[0] ?? 1) * (args[1] ?? 1) * (args[2] ?? 1);
          const descriptor = getObject(state.pipeline)?.descriptor;
          const module = getObject(descriptor?.compute?.module?.__id);
          let size = null;
          try {
            size = module ? workgroupSizeFor(module, descriptor.compute.entryPoint) : null;
          } catch (e) {
            size = null;
          }
          const invocations = size ? groups * size[0] * size[1] * size[2] : null;
          if (groups === 1 && (invocations === null || invocations < SMALL_DISPATCH_INVOCATIONS)) {
            smallDispatch.add(command, invocations === null ? "1 workgroup" : plural(invocations, "invocation"));
          } else if (invocations !== null && invocations < SMALL_DISPATCH_INVOCATIONS) {
            smallDispatch.add(command, plural(invocations, "invocation"));
          }
        }
      }
    };

    for (const { command } of executionOrder(commands)) {
      const method = command.method;
      if (method === "beginRenderPass" || method === "beginComputePass") {
        const descriptor = command.args?.[0] ?? {};
        const clears = method === "beginRenderPass" && (
          (descriptor.colorAttachments ?? []).some((a) => a && a.loadOp === "clear") ||
          descriptor.depthStencilAttachment?.depthLoadOp === "clear" ||
          descriptor.depthStencilAttachment?.stencilLoadOp === "clear");
        pass = { command, work: 0, clears, state: newState() };
        continue;
      }
      if (!pass) {
        continue;
      }
      if (method === "end") {
        if (!pass.work && !pass.clears) {
          const label = pass.command.args?.[0]?.label;
          emptyPasses.add(pass.command, label ? `"${label}"` : null);
        }
        pass = null;
        continue;
      }
      if (method === "executeBundles") {
        for (const ref of command.args?.[0] ?? []) {
          const bundleCommands = resolver.getBundleCommands?.(ref?.__id) ?? getObject(ref?.__id)?.commands ?? [];
          const bundleState = newState();
          for (const bundleCommand of bundleCommands) {
            walk(bundleCommand, bundleState);
          }
        }
        if ((command.args?.[0] ?? []).length) {
          pass.work++;
        }
        // executeBundles clears the pass's state.
        pass.state = newState();
        continue;
      }
      walk(command, pass.state);
    }

    if (emptyPasses.count) {
      add("empty-pass", "medium", "high",
        `${plural(emptyPasses.count, "pass", "passes")} ${emptyPasses.count === 1 ? "records" : "record"} no draws or dispatches and ${emptyPasses.count === 1 ? "clears" : "clear"} nothing${emptyPasses.subjects.length ? `: ${emptyPasses.subjectText}` : ""}. ` +
        `A render pass still loads and stores its attachments, which on a tiled GPU is a full read and write of each target, so an empty one is pure cost; skip recording it.`, emptyPasses);
    }
    if (redundantPipeline.count) {
      add("redundant-pipeline-bind", "low", "high",
        `setPipeline binds the pipeline that is already bound ${times(redundantPipeline)}. Implementations don't always skip the redundant bind; setting it once per change is free.`, redundantPipeline);
    }
    if (redundantBindGroup.count) {
      add("redundant-bind-group", "low", "high",
        `setBindGroup binds the bind group (with the same dynamic offsets) already bound at that index ${times(redundantBindGroup)}. Binding once per change saves the call and the implementation's validation of it.`, redundantBindGroup);
    }
    if (redundantBuffer.count) {
      add("redundant-buffer-bind", "low", "high",
        `setVertexBuffer or setIndexBuffer binds the buffer, offset and size already bound ${times(redundantBuffer)}.`, redundantBuffer);
    }
    if (redundantState.count) {
      add("redundant-state", "low", "high",
        `${redundantState.subjectText} ${redundantState.count === 1 ? "sets" : "set"} the value already in effect ${times(redundantState)}.`, redundantState);
    }
    if (tinyDraws.count >= TINY_DRAW_COUNT) {
      add("tiny-draws", "medium", "medium",
        `${tinyDraws.count} of ${drawCount} draws render at most ${TINY_DRAW_VERTICES} vertices each, without instancing. ` +
        `Per-draw overhead (validation, state changes, command processing) outweighs draws that small; instancing or merging the geometry renders them in one draw.`, tinyDraws);
    }
    if (smallDispatch.count) {
      add("small-dispatch", "low", "medium",
        `${plural(smallDispatch.count, "dispatch", "dispatches")} ${smallDispatch.count === 1 ? "runs" : "run"} fewer than ${SMALL_DISPATCH_INVOCATIONS} invocations in total (${smallDispatch.subjectText}): most of the GPU idles while ${smallDispatch.count === 1 ? "it runs" : "they run"}. ` +
        `Folding the work of several small dispatches into one, or a larger workgroup, keeps the machine busy.`, smallDispatch);
    }
  }

  // --------------------------------------------------- render graph rules
  let graph = options.graph ?? null;
  try {
    graph ??= buildFrameRenderGraph(commands, resolver);
  } catch (e) {
    graph = null;
  }
  if (graph) {
    // Attachment loads of contents from before the frame.
    const canvasLoads = new Folded();
    const colorLoads = new Folded();
    for (const node of graph.nodes) {
      for (const read of node.reads) {
        if (!read.usage.includes("attachment (load)") || read.version.index !== 0) {
          continue;
        }
        if (read.resource.sink === "presented") {
          canvasLoads.add(node.command, node.label);
        } else {
          colorLoads.add(node.command, `${node.label} loads ${read.resource.label}`);
        }
      }
    }
    if (canvasLoads.count) {
      add("canvas-load", "medium", "high",
        `${plural(canvasLoads.count, "pass", "passes")} ${canvasLoads.count === 1 ? "loads" : "load"} the canvas texture before anything in the frame rendered to it: ${canvasLoads.subjectText}. ` +
        `getCurrentTexture() returns a texture cleared to zero, so loadOp: "load" reads back nothing useful; loadOp: "clear" gives the same result without the read.`, canvasLoads);
    }
    if (colorLoads.count) {
      add("color-load", "low", "medium",
        `${plural(colorLoads.count, "attachment")} ${colorLoads.count === 1 ? "is" : "are"} loaded (loadOp: "load") before anything in the frame rendered to ${colorLoads.count === 1 ? "it" : "them"}: ${colorLoads.subjectText}. ` +
        `That reads the previous frame's contents into tile memory. If the pass covers the whole target and doesn't need them, loadOp: "clear" skips the read. A target that accumulates across frames needs the load.`, colorLoads);
    }

    for (const f of analyzeRenderGraph(graph).findings) {
      const commandsOfNodes = f.nodes.map((n) => n.command).filter(Boolean);
      findings.push({
        rule: f.rule,
        severity: f.severity,
        confidence: f.confidence,
        message: f.message,
        command: f.node?.command ?? commandsOfNodes[0] ?? null,
        commands: commandsOfNodes,
        count: f.count,
      });
    }
  }

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count);

  const byCommand = new Map();
  for (const f of findings) {
    for (const command of f.commands) {
      const list = byCommand.get(command);
      if (list) {
        list.push(f);
      } else {
        byCommand.set(command, [f]);
      }
    }
  }
  return { findings, byCommand };
}
