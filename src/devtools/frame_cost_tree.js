import { getShaderCostTree, findCostEntry } from "./shader_cost.js";
import { collectFrameInvocations } from "./shader_invocations.js";
import { mergeCostTree, rescaleCostTree } from "wgsl_reflect/wgsl_reflect.module.js";

/**
 * Frame-level shader cost tree: the frame's GPU work broken down by pass,
 * pipeline, shader entry point and statement.
 *
 * Combines three sources, each labelled by how trustworthy it is:
 *
 *   measured - pass GPU durations from timestamp queries, and fragment counts
 *              from GPU replay. Real numbers.
 *   exact    - vertex and compute invocation counts read out of the captured
 *              draw and dispatch arguments.
 *   modeled  - the per-invocation instruction mix from the static cost model,
 *              which is what distributes a measured pass duration across the
 *              shaders inside it.
 *
 * When every pass has a measured duration the whole tree reads in milliseconds:
 * the root and each pass width are then real, and only the split *within* a
 * pass is modeled. Without timestamps it falls back to modeled op units, which
 * are comparable to each other but not to wall-clock time.
 *
 * This module is deliberately free of DOM dependencies so it can be unit
 * tested; frame_flamegraph.js renders what it returns.
 */

export const MS = "ms";
export const OPS = "ops";

export function formatCostValue(value, units) {
  if (units === MS) {
    return `${value.toFixed(3)} ms`;
  }
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(1)}G ops`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M ops`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)}k ops`;
  }
  return `${value.toFixed(1)} ops`;
}

function makeNode(kind, name, totalCost, children) {
  return {
    kind,
    name,
    line: 0,
    endLine: 0,
    start: -1,
    end: -1,
    self: null,
    total: null,
    selfCost: 0,
    totalCost,
    iterations: 1,
    iterationsKnown: true,
    estimated: false,
    children: children ?? [],
  };
}

/** Sum children totals into a node built bottom-up. */
function rollup(node) {
  let total = 0;
  for (const child of node.children) {
    total += child.totalCost;
    node.estimated = node.estimated || child.estimated;
  }
  node.totalCost = total;
  return node;
}

function scaleSubtree(node, factor) {
  node.totalCost *= factor;
  node.selfCost *= factor;
  for (const child of node.children) {
    scaleSubtree(child, factor);
  }
}

/**
 * @param {Object} params
 * @param {Object[]} params.commands - the capture's command list
 * @param {(id:number)=>Object} params.getObject - resolve a captured object id
 * @param {Map<string,number>} [params.fragmentCounts] - measured fragment counts
 *   keyed by `${passIndex}:${bucketKey}`; absent entries stay unknown
 * @param {boolean} [params.perDraw=false] - one frame per draw rather than one
 *   per pipeline
 * @param {number} [params.maxFramesPerPass=32] - cap on expanded frames per
 *   pass; the costliest survive and the tail collapses into one frame that
 *   keeps its cost. Real frames reach thousands of draws, and a flame graph
 *   with tens of thousands of DOM frames is unusable.
 * @param {Map<Object,{ms:number,repeats:number}>} [params.drawTimings] - measured
 *   per-draw GPU time from draw_timing.js, keyed by the capture command record.
 *   When present, a bucket's width is its *measured* time rather than a share of
 *   the pass derived from the model — the model then only distributes cost
 *   within the bucket, across its shader stages and statements.
 * @returns {{root:Object, units:string, warnings:string[], stats:Object,
 *            groups:Array, passes:Array}}
 */
export function buildFrameCostTree({ commands, getObject, fragmentCounts, perDraw, maxFramesPerPass = 32, drawTimings }) {
  const { passes, warnings } = collectFrameInvocations(commands, getObject);
  const notes = warnings.slice();

  // Per-draw measurements, when available, outrank pass timestamps: they make
  // the width of every draw a measured number instead of a modeled share.
  const timedItems = drawTimings
    ? passes.reduce((a, p) => a + p.items.filter((i) => drawTimings.has(i.command)).length, 0)
    : 0;
  const totalItems = passes.reduce((a, p) => a + p.items.length, 0);
  const useDrawTimings = timedItems > 0;

  // Milliseconds only make sense if *every* pass is measured; a tree mixing
  // measured ms with modeled ops would give a meaningless root total.
  const measuredPasses = passes.filter((p) => p.durationMs !== null && p.durationMs > 0);
  const allMeasured = passes.length > 0 && measuredPasses.length === passes.length;
  const units = (useDrawTimings || allMeasured) ? MS : OPS;

  if (useDrawTimings) {
    notes.push(`Draw widths are measured GPU time (${timedItems} of ${totalItems} draws timed by replay). The model only distributes each draw's measured time across its shader stages and statements.`);
    // Isolated draws don't share state or overlap the way they do in the real
    // pass, so the sum is an over-estimate of the pass. Saying so is the whole
    // difference between a useful number and a misleading one.
    notes.push("Each draw is timed in isolation, so the per-draw times do not add up to the pass's own measured duration — a real pass overlaps consecutive draws and reuses state. Compare draws against each other, not against the pass total.");
    if (timedItems < totalItems) {
      notes.push(`${totalItems - timedItems} draw(s) could not be timed and fall back to their modeled cost, which is not comparable to the measured ones.`);
    }
  } else if (!allMeasured && measuredPasses.length > 0) {
    notes.push(`Only ${measuredPasses.length} of ${passes.length} passes have GPU timings, so the graph is in modeled op units rather than milliseconds. Re-capture with "Profile Passes" enabled for a timed graph.`);
  } else if (!allMeasured && passes.length > 0) {
    notes.push('No GPU pass timings in this capture, so the graph is in modeled op units. Re-capture with "Profile Passes" enabled to scale it to measured milliseconds.');
  }

  const stats = {
    passes: passes.length,
    unknownStages: 0,
    totalStages: 0,
    unmeasuredFragmentStages: 0,
    collapsedBuckets: 0,
    partiallyTimedBuckets: 0,
    timedItems,
    totalItems,
  };
  // Draw groups the fragment measurement can later be run against.
  const groups = [];
  const passNodes = [];

  for (const pass of passes) {
    // Group draws by pipeline unless the caller asked for per-draw detail.
    const buckets = new Map();
    for (const item of pass.items) {
      const key = perDraw ? `d${item.command.id ?? buckets.size}` : `p${item.pipelineId}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, items: [], pipelineId: item.pipelineId };
        buckets.set(key, bucket);
      }
      bucket.items.push(item);
    }

    // Resolve every bucket's stages to a *scalar* cost first, without building
    // any subtrees. Real frames reach thousands of draws, and expanding a
    // shader subtree per draw would be tens of thousands of frames plus a tree
    // copy each — so only the buckets that survive the cap get expanded.
    const resolved = [];
    for (const bucket of buckets.values()) {
      // Accumulate invocations per (stage, module, entryPoint) across the
      // bucket, so one frame represents all of the bucket's work in that stage.
      const stageTotals = new Map();
      const fragmentDraws = new Set();

      for (const item of bucket.items) {
        for (const stage of item.stages) {
          stats.totalStages++;
          const key = `${stage.stage}:${stage.module.id}:${stage.entryPoint ?? ""}`;
          let acc = stageTotals.get(key);
          if (!acc) {
            acc = {
              stage: stage.stage,
              module: stage.module,
              entryPoint: stage.entryPoint,
              invocations: 0,
              confidence: stage.confidence,
              unknown: false,
            };
            stageTotals.set(key, acc);
          }
          if (stage.invocations === null) {
            acc.unknown = true;
          } else {
            acc.invocations += stage.invocations;
            // The weakest confidence in the group wins.
            if (stage.confidence === "upperBound" && acc.confidence === "exact") {
              acc.confidence = "upperBound";
            }
          }
          if (stage.stage === "fragment") {
            fragmentDraws.add(item.command);
          }
        }
      }

      const groupKey = `${pass.index}:${bucket.key}`;
      if (fragmentDraws.size) {
        groups.push({ key: groupKey, draws: fragmentDraws, pass, bucket });
      }

      const stages = [];
      let bucketCost = 0;
      for (const acc of stageTotals.values()) {
        // Fragment counts only exist once the measurement pass has been run.
        if (acc.stage === "fragment") {
          const measured = fragmentCounts?.get(groupKey);
          if (measured !== undefined) {
            acc.invocations = measured;
            acc.unknown = false;
            acc.confidence = "measured";
          } else {
            acc.unknown = true;
            stats.unmeasuredFragmentStages++;
          }
        }

        const costTree = getShaderCostTree(acc.module);
        const entry = findCostEntry(costTree, acc.stage, acc.entryPoint);
        const usable = !!entry && !acc.unknown && acc.invocations > 0;
        if (!usable) {
          stats.unknownStages++;
        }
        const cost = usable ? entry.costPerInvocation * acc.invocations : 0;
        bucketCost += cost;
        stages.push({ acc, costTree, entry, usable, cost });
      }

      // With per-draw measurements, the bucket's width is its measured time and
      // the model's only job is splitting that time between the stages inside
      // it. `scale` converts modeled op units to measured ms for this bucket.
      let measuredMs = null;
      if (useDrawTimings) {
        let sum = 0;
        let have = 0;
        for (const item of bucket.items) {
          const timing = drawTimings.get(item.command);
          if (timing) {
            sum += timing.ms;
            have++;
          }
        }
        measuredMs = have > 0 ? sum : null;
        if (have > 0 && have < bucket.items.length) {
          stats.partiallyTimedBuckets++;
        }
      }
      const scale = (measuredMs !== null && bucketCost > 0) ? measuredMs / bucketCost : 1;
      resolved.push({
        bucket,
        stages,
        // Order and width by the measured time when there is one.
        cost: measuredMs !== null ? measuredMs : bucketCost,
        measuredMs,
        scale,
      });
    }

    // Keep the costliest buckets, collapse the tail. Sorting by cost means the
    // frames that survive are the ones worth looking at.
    let kept = resolved;
    let collapsed = null;
    if (resolved.length > maxFramesPerPass) {
      const sorted = resolved.slice().sort((a, b) => b.cost - a.cost);
      kept = sorted.slice(0, maxFramesPerPass);
      const tail = sorted.slice(maxFramesPerPass);
      const tailCost = tail.reduce((a, r) => a + r.cost, 0);
      const tailDraws = tail.reduce((a, r) => a + r.bucket.items.length, 0);
      collapsed = { count: tail.length, draws: tailDraws, cost: tailCost };
      stats.collapsedBuckets += tail.length;
    }

    const itemNodes = [];
    for (const { bucket, stages, measuredMs, scale } of kept) {
      const stageNodes = [];
      for (const { acc, costTree, entry, usable, cost: modeledCost } of stages) {
        const cost = modeledCost * scale;
        const label = `${acc.stage}: ${acc.entryPoint ?? entry?.name ?? "?"}`;

        if (!usable) {
          // Carry the frame at zero width rather than dropping it, so the
          // reason it isn't weighted stays visible in the graph.
          const reason = !entry ? "not analyzable" : "invocation count unknown";
          const node = makeNode("recursive", `${label} — ${reason}`, 0, []);
          node.estimated = true;
          stageNodes.push(node);
          continue;
        }

        const scaled = rescaleCostTree(mergeCostTree(entry.root, costTree.weights), cost);
        const suffix = acc.confidence === "measured" ? " measured"
          : acc.confidence === "upperBound" ? " max" : "";
        const node = makeNode(
          "function",
          `${label} — ${acc.invocations.toLocaleString()}${suffix} invocations`,
          cost,
          scaled.children);
        node.self = scaled.self;
        node.total = scaled.total;
        node.selfCost = scaled.selfCost;
        node.estimated = scaled.estimated || acc.confidence !== "exact";
        node.invocations = acc.invocations;
        node.confidence = acc.confidence;
        node.module = acc.module;
        // Enough context for an ablation sweep to be launched from this frame.
        // In grouped mode the bucket holds several draws, so the first stands in
        // for the group; `drawCount` lets the UI say so.
        node.stage = acc.stage;
        node.entryPoint = acc.entryPoint;
        node.command = bucket.items[0].command;
        node.drawCount = bucket.items.length;
        stageNodes.push(node);
      }

      const drawCount = bucket.items.length;
      const pipeline = getObject(bucket.pipelineId);
      const pipelineLabel = pipeline?.label || pipeline?.descriptor?.label ||
        (bucket.pipelineId !== undefined ? `Pipeline ${bucket.pipelineId}` : "Pipeline");
      const noun = bucket.items[0].kind === "draw" ? "draw" : "dispatch";
      const name = perDraw
        ? `${bucket.items[0].method}`
        : `${pipelineLabel} — ${drawCount} ${noun}${drawCount === 1 ? "" : "s"}`;

      const itemNode = rollup(makeNode("loop", name, 0, stageNodes));
      itemNode.command = bucket.items[0].command;
      // A stage with no measured invocation count has zero width, so its frame
      // is culled and can't be clicked. Carry the ablation targets on the draw
      // frame too, which is always visible.
      itemNode.ablationTargets = stages
        .filter((s) => s.acc.stage === "vertex" || s.acc.stage === "fragment" || s.acc.stage === "compute")
        .map((s) => ({
          stage: s.acc.stage,
          entryPoint: s.acc.entryPoint,
          module: s.acc.module,
          command: bucket.items[0].command,
          drawCount: bucket.items.length,
        }));
      if (measuredMs !== null) {
        itemNode.measuredMs = measuredMs;
        // A measured draw whose shaders couldn't be modeled still has a real
        // width; show it as one opaque frame rather than losing the measurement.
        if (itemNode.totalCost <= 0) {
          itemNode.totalCost = measuredMs;
          itemNode.children = [];
          itemNode.estimated = true;
        }
      }
      itemNodes.push(itemNode);
    }

    // The collapsed tail keeps its cost so the pass total stays correct — which
    // matters most in ms mode, where the pass total is a measured number.
    if (collapsed) {
      const label = perDraw
        ? `+ ${collapsed.count} more draws`
        : `+ ${collapsed.count} more pipelines (${collapsed.draws} draws)`;
      itemNodes.push(makeNode("branch", label, collapsed.cost, []));
    }

    const kindLabel = pass.kind === "render" ? "Render" : "Compute";
    const passLabel = pass.label
      ? `${kindLabel} Pass "${pass.label}"`
      : `${kindLabel} Pass ${pass.index}`;
    const passNode = rollup(makeNode("entry", passLabel, 0, itemNodes));
    passNode.command = pass.command;
    passNode.durationMs = pass.durationMs;

    // With per-draw measurements the draws are already in real ms, so the pass
    // is just their sum — rescaling to the pass timestamp here would throw the
    // measurements away and re-impose the modeled distribution.
    //
    // Otherwise, in ms mode the pass's measured duration is authoritative:
    // rescale the modeled subtree to fill exactly that much time. Children keep
    // their modeled *proportions* — measured total, modeled split.
    if (units === MS && !useDrawTimings) {
      const modeledTotal = passNode.totalCost;
      if (modeledTotal > 0) {
        scaleSubtree(passNode, pass.durationMs / modeledTotal);
      } else {
        // Nothing modelable in this pass (every count unknown); still show the
        // measured time, as one opaque frame.
        passNode.children = [];
        passNode.estimated = true;
      }
      passNode.totalCost = pass.durationMs;
    }

    passNodes.push(passNode);
  }

  const root = rollup(makeNode("entry", "Frame", 0, passNodes));
  if (useDrawTimings) {
    // Deliberately not called "GPU time": this is the sum of draws measured in
    // isolation, which overstates a real frame that overlaps them.
    root.name = `Frame — ${root.totalCost.toFixed(2)} ms of isolated draw time`;
  } else if (units === MS) {
    root.name = `Frame — ${root.totalCost.toFixed(2)} ms GPU`;
  }

  if (stats.unmeasuredFragmentStages > 0) {
    notes.push(`${stats.unmeasuredFragmentStages} fragment stage(s) have no invocation count and are shown unweighted. Fragment counts can only be obtained by replaying the frame — use "Measure fragments" to include them.`);
  }
  if (stats.collapsedBuckets > 0) {
    // Never let a cap be silent: a truncated graph that looks complete is worse
    // than no graph.
    notes.push(`${stats.collapsedBuckets} lower-cost ${perDraw ? "draw" : "pipeline"} group(s) are collapsed into "+ more" frames (showing the ${maxFramesPerPass} costliest per pass). Their cost is still counted in the pass totals.`);
  }

  return { root, units, warnings: notes, stats, groups, passes };
}
