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
 * @returns {{root:Object, units:string, warnings:string[], stats:Object,
 *            groups:Array, passes:Array}}
 */
export function buildFrameCostTree({ commands, getObject, fragmentCounts, perDraw }) {
  const { passes, warnings } = collectFrameInvocations(commands, getObject);
  const notes = warnings.slice();

  // Milliseconds only make sense if *every* pass is measured; a tree mixing
  // measured ms with modeled ops would give a meaningless root total.
  const measuredPasses = passes.filter((p) => p.durationMs !== null && p.durationMs > 0);
  const allMeasured = passes.length > 0 && measuredPasses.length === passes.length;
  const units = allMeasured ? MS : OPS;
  if (!allMeasured && measuredPasses.length > 0) {
    notes.push(`Only ${measuredPasses.length} of ${passes.length} passes have GPU timings, so the graph is in modeled op units rather than milliseconds. Re-capture with "Profile Passes" enabled for a timed graph.`);
  } else if (!allMeasured && passes.length > 0) {
    notes.push('No GPU pass timings in this capture, so the graph is in modeled op units. Re-capture with "Profile Passes" enabled to scale it to measured milliseconds.');
  }

  const stats = {
    passes: passes.length,
    unknownStages: 0,
    totalStages: 0,
    unmeasuredFragmentStages: 0,
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

    const itemNodes = [];
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

      const stageNodes = [];
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
        const label = `${acc.stage}: ${acc.entryPoint ?? entry?.name ?? "?"}`;

        if (!entry || acc.unknown || acc.invocations <= 0) {
          // Carry the frame at zero width rather than dropping it, so the
          // reason it isn't weighted stays visible in the graph.
          stats.unknownStages++;
          const reason = !entry ? "not analyzable" : "invocation count unknown";
          const node = makeNode("recursive", `${label} — ${reason}`, 0, []);
          node.estimated = true;
          stageNodes.push(node);
          continue;
        }

        const modeled = entry.costPerInvocation * acc.invocations;
        const scaled = rescaleCostTree(mergeCostTree(entry.root, costTree.weights), modeled);
        const suffix = acc.confidence === "measured" ? " measured"
          : acc.confidence === "upperBound" ? " max" : "";
        const node = makeNode(
          "function",
          `${label} — ${acc.invocations.toLocaleString()}${suffix} invocations`,
          modeled,
          scaled.children);
        node.self = scaled.self;
        node.total = scaled.total;
        node.selfCost = scaled.selfCost;
        node.estimated = scaled.estimated || acc.confidence !== "exact";
        node.invocations = acc.invocations;
        node.confidence = acc.confidence;
        node.module = acc.module;
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
      itemNodes.push(itemNode);
    }

    const kindLabel = pass.kind === "render" ? "Render" : "Compute";
    const passLabel = pass.label
      ? `${kindLabel} Pass "${pass.label}"`
      : `${kindLabel} Pass ${pass.index}`;
    const passNode = rollup(makeNode("entry", passLabel, 0, itemNodes));
    passNode.command = pass.command;
    passNode.durationMs = pass.durationMs;

    // In ms mode the measured duration is authoritative: rescale the modeled
    // subtree to fill exactly that much time. Children keep their modeled
    // *proportions*, which is the point — measured totals, modeled split.
    if (units === MS) {
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
  if (units === MS) {
    root.name = `Frame — ${root.totalCost.toFixed(2)} ms GPU`;
  }

  if (stats.unmeasuredFragmentStages > 0) {
    notes.push(`${stats.unmeasuredFragmentStages} fragment stage(s) have no invocation count and are shown unweighted. Fragment counts can only be obtained by replaying the frame — use "Measure fragments" to include them.`);
  }

  return { root, units, warnings: notes, stats, groups, passes };
}
