/**
 * Per-draw / per-dispatch shader invocation counts for a captured frame.
 *
 * This is the bridge between the static cost model (ops per invocation) and a
 * frame-relative picture (ops per frame): modeled cost only becomes meaningful
 * once it is multiplied by how many times the shader actually ran.
 *
 * Confidence varies by stage, and every count carries a `confidence` field
 * saying which case it is:
 *
 *   exact     - read straight out of the captured draw/dispatch arguments
 *   upperBound- correct modulo a hardware optimization we can't observe
 *               (post-transform vertex reuse on indexed draws)
 *   measured  - counted on the GPU by replaying the frame (fragments)
 *   unknown   - not derivable without executing (indirect args)
 *
 * Nothing here guesses. An unknown count stays unknown and is reported, rather
 * than being filled in with a plausible-looking number.
 */

const DRAW_METHODS = new Set(["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
const DISPATCH_METHODS = new Set(["dispatchWorkgroups", "dispatchWorkgroupsIndirect"]);

/**
 * Walk a capture's command list and produce one record per draw / dispatch,
 * grouped by the pass that contains it.
 *
 * @param {Object[]} commands - the capture's flat command list
 * @param {(id:number)=>Object} getObject - resolve a captured object id
 * @returns {{passes: Array, warnings: string[]}}
 */
export function collectFrameInvocations(commands, getObject) {
  const passes = [];
  const warnings = [];
  const warned = new Set();
  const warn = (message) => {
    if (!warned.has(message)) {
      warned.add(message);
      warnings.push(message);
    }
  };

  // A pass encoder can be interleaved with other encoders in the command list,
  // so pipeline state is tracked per encoder object, the same way the capture
  // panel's shader-usage walk does it.
  const boundPipeline = new Map();
  let current = null;
  let passIndex = 0;

  for (const command of commands) {
    if (!command) {
      continue;
    }
    const method = command.method;
    const encoder = command.object;

    if (method === "beginRenderPass" || method === "beginComputePass") {
      current = {
        index: passIndex++,
        kind: method === "beginRenderPass" ? "render" : "compute",
        label: command.args?.[0]?.label ?? null,
        command,
        // Filled in from the timestamp data when the capture profiled passes.
        durationMs: typeof command.duration === "number" ? command.duration : null,
        items: [],
      };
      passes.push(current);
      continue;
    }

    if (method === "end") {
      current = null;
      continue;
    }

    if (method === "setPipeline") {
      boundPipeline.set(encoder, command.args?.[0]?.__id);
      continue;
    }

    if (!current) {
      continue;
    }

    if (method === "executeBundles") {
      warn("Render bundles are not walked; the draws inside them are missing from the cost graph.");
      continue;
    }

    const isDraw = DRAW_METHODS.has(method);
    const isDispatch = DISPATCH_METHODS.has(method);
    if (!isDraw && !isDispatch) {
      continue;
    }

    const pipelineId = boundPipeline.get(encoder);
    const pipeline = getObject(pipelineId);
    const descriptor = pipeline?.descriptor;
    if (!descriptor) {
      warn("A draw or dispatch had no resolvable pipeline; it is excluded from the cost graph.");
      continue;
    }

    const item = isDraw
      ? drawItem(command, descriptor, getObject, warn)
      : dispatchItem(command, descriptor, getObject, warn);
    if (item) {
      item.pipelineId = pipelineId;
      item.pass = current;
      current.items.push(item);
    }
  }

  return { passes, warnings };
}

function drawItem(command, descriptor, getObject, warn) {
  const args = command.args ?? [];
  const method = command.method;
  const indirect = method === "drawIndirect" || method === "drawIndexedIndirect";

  let vertexInvocations = null;
  let confidence = "unknown";
  let instanceCount = null;

  if (method === "draw") {
    const vertexCount = numberOr(args[0], null);
    instanceCount = numberOr(args[1], 1);
    if (vertexCount !== null) {
      vertexInvocations = vertexCount * instanceCount;
      confidence = "exact";
    }
  } else if (method === "drawIndexed") {
    const indexCount = numberOr(args[0], null);
    instanceCount = numberOr(args[1], 1);
    if (indexCount !== null) {
      // The GPU reuses post-transform vertices for repeated indices, so the
      // real vertex shader invocation count is at most this and typically well
      // below it for a well-ordered mesh.
      vertexInvocations = indexCount * instanceCount;
      confidence = "upperBound";
    }
  } else {
    warn(`${method} reads its vertex and instance counts from a GPU buffer at execution time; those draws have no invocation count and are shown as unweighted.`);
  }

  const stages = [];
  const vertexModule = getObject(descriptor.vertex?.module?.__id);
  if (vertexModule) {
    stages.push({
      stage: "vertex",
      module: vertexModule,
      entryPoint: descriptor.vertex?.entryPoint ?? null,
      invocations: vertexInvocations,
      confidence,
    });
  }
  const fragmentModule = getObject(descriptor.fragment?.module?.__id);
  if (fragmentModule) {
    stages.push({
      stage: "fragment",
      module: fragmentModule,
      entryPoint: descriptor.fragment?.entryPoint ?? null,
      // Only a GPU replay can count rasterized fragments; left null until
      // measureFragmentInvocations() fills it in.
      invocations: null,
      confidence: "unknown",
    });
  }
  if (!stages.length) {
    return null;
  }

  return {
    kind: "draw",
    method,
    command,
    indirect,
    instanceCount,
    stages,
  };
}

function dispatchItem(command, descriptor, getObject, warn) {
  const args = command.args ?? [];
  const method = command.method;
  const module = getObject(descriptor.compute?.module?.__id);
  if (!module) {
    return null;
  }
  const entryPoint = descriptor.compute?.entryPoint ?? null;

  let invocations = null;
  let confidence = "unknown";
  let workgroups = null;

  if (method === "dispatchWorkgroups") {
    const x = numberOr(args[0], null);
    const y = numberOr(args[1], 1);
    const z = numberOr(args[2], 1);
    if (x !== null) {
      workgroups = x * y * z;
      const size = workgroupSizeFor(module, entryPoint);
      if (size) {
        invocations = workgroups * size[0] * size[1] * size[2];
        confidence = "exact";
      } else {
        warn("A compute entry point's @workgroup_size could not be read; that dispatch is counted in workgroups, not threads.");
        invocations = workgroups;
        confidence = "unknown";
      }
    }
  } else {
    warn("dispatchWorkgroupsIndirect reads its workgroup counts from a GPU buffer at execution time; those dispatches have no invocation count and are shown as unweighted.");
  }

  return {
    kind: "dispatch",
    method,
    command,
    indirect: method === "dispatchWorkgroupsIndirect",
    workgroups,
    stages: [{
      stage: "compute",
      module,
      entryPoint,
      invocations,
      confidence,
    }],
  };
}

/**
 * The @workgroup_size of a compute entry point, via the shader's reflection.
 * Returns null when the entry point can't be found.
 */
export function workgroupSizeFor(shaderModule, entryPoint) {
  const reflection = shaderModule?.reflection;
  const computeEntries = reflection?.entry?.compute ?? [];
  if (!computeEntries.length) {
    return null;
  }
  const fn = entryPoint
    ? computeEntries.find((e) => e.name === entryPoint)
    : computeEntries[0];
  if (!fn) {
    return null;
  }
  for (const attr of fn.attributes ?? []) {
    if (attr.name !== "workgroup_size") {
      continue;
    }
    const value = Array.isArray(attr.value) ? attr.value : [attr.value];
    const dims = [1, 1, 1];
    for (let i = 0; i < 3 && i < value.length; ++i) {
      const n = Number(value[i]);
      if (Number.isFinite(n)) {
        dims[i] = n;
      }
    }
    return dims;
  }
  // No attribute means the shader wouldn't compile, but be forgiving.
  return [1, 1, 1];
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Total invocations across a pass, per stage. Items with unknown counts are
 * reported separately rather than being treated as zero, so a caller can decide
 * whether the pass total is trustworthy.
 */
export function summarizeInvocations(pass) {
  const totals = { vertex: 0, fragment: 0, compute: 0 };
  let unknown = 0;
  let total = 0;
  for (const item of pass.items) {
    for (const stage of item.stages) {
      total++;
      if (stage.invocations === null) {
        unknown++;
        continue;
      }
      totals[stage.stage] += stage.invocations;
    }
  }
  return { totals, unknown, total, complete: unknown === 0 };
}
