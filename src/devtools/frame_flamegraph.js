import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Checkbox } from "./widget/checkbox.js";
import { Button } from "./widget/button.js";
import { FlameGraph } from "./widget/flamegraph.js";
import { buildFrameCostTree, formatCostValue, MS, OPS } from "./frame_cost_tree.js";
import { measureFragmentCounts } from "./capture_replay.js";
import { measureDrawTimings, detectTimingSupport } from "./draw_timing.js";
import { measureStatementCosts } from "./ablation_measure.js";
import { dominantDimension } from "wgsl_reflect/wgsl_reflect.module.js";

// See frame_cost_tree.js for what the numbers mean and where they come from.

const LEGEND = [
  ["alu", "ALU"],
  ["sfu", "SFU"],
  ["texture", "Texture"],
  ["memory", "Memory"],
];

function colorOf(node) {
  if (node.total) {
    return FlameGraph.dimensionColors[dominantDimension(node.total)] ?? "#4a8db8";
  }
  return FlameGraph.kindColors[node.kind] ?? "#4a8db8";
}

/**
 * Build the frame shader flame graph panel.
 *
 * @param {Object} options
 * @param {Object[]} options.commands - the capture's command list
 * @param {(id:number)=>Object} options.getObject
 * @param {Object} [options.database] - required for fragment measurement
 * @param {()=>GPUDevice|null} [options.getDevice] - ditto
 * @param {Function} [options.getTextureFromAttachment] - ditto
 * @param {(command:Object)=>void} [options.onSelectCommand] - jump to a command
 * @returns {Widget} a Div panel
 */
export function buildFrameFlameGraph(options) {
  const panel = new Div(null, { class: "flame-panel flame-frame-panel" });

  let perDraw = false;
  let fragmentCounts = null;
  let drawTimings = null;
  let measuring = false;
  let units = OPS;
  let groups = [];

  const controls = new Div(panel, { class: "flame-controls" });
  new Checkbox(controls, {
    label: "Per draw",
    checked: false,
    onChange: (checked) => {
      perDraw = checked;
      // Fragment counts are measured per bucket, and the buckets change with
      // the grouping mode — a per-draw bucket is a subset of a pipeline one, so
      // the old counts can't be re-attributed. Drop them rather than silently
      // dropping the fragment stages that no longer match a key. Draw timings
      // are keyed by the command itself, so they survive the toggle.
      if (fragmentCounts) {
        fragmentCounts = null;
        new Div(notes, {
          class: "flame-note",
          text: "Fragment counts were cleared because the grouping changed; measure again to weight fragment stages in this view.",
        });
      }
      update();
    },
  });

  const measureButton = new Button(controls, {
    label: "Measure fragments",
    class: "btn",
    callback: () => measureFragments(),
  });
  measureButton.element.title =
    "Replay the frame on the GPU to count rasterized fragments, so fragment shaders can be weighted by their real invocation count.";

  const timeButton = new Button(controls, {
    label: "Measure draw times",
    class: "btn",
    callback: () => measureTimings(),
  });
  timeButton.element.title =
    "Replay each draw on the GPU with timestamp queries, so every draw's width is measured time rather than a modeled share of its pass.";

  const ablateButton = new Button(controls, {
    label: "Measure statements",
    class: "btn",
    callback: () => measureStatements(),
  });
  ablateButton.disabled = true;
  ablateButton.element.title =
    "Select a shader stage frame first, then measure the cost of its individual statements by replaying the draw with the shader progressively cut short.";

  const resetButton = new Button(controls, {
    label: "Reset zoom",
    class: "btn",
    callback: () => graph.resetZoom(),
  });
  resetButton.element.title = "Zoom back out to the whole frame";

  const summary = new Div(panel, { class: "flame-summary" });

  const legend = new Div(panel, { class: "flame-legend" });
  new Span(legend, { class: "flame-legend-label", text: "Cost:" });
  for (const [dim, label] of LEGEND) {
    const item = new Div(legend, { class: "flame-legend-item" });
    new Span(item, { class: "flame-legend-swatch", style: `background: ${FlameGraph.dimensionColors[dim]};` });
    new Span(item, { text: label });
  }

  const graph = new FlameGraph(panel, {
    formatValue: (n) => formatCostValue(n.totalCost, units),
    colorOf,
    tooltipOf: (n) => {
      const lines = [n.name, formatCostValue(n.totalCost, units)];
      if (n.measuredMs !== undefined && n.measuredMs !== null) {
        lines.push(`Measured in isolation: ${n.measuredMs.toFixed(4)} ms`);
      }
      if (n.durationMs !== undefined && n.durationMs !== null) {
        lines.push(`Pass GPU time: ${n.durationMs.toFixed(3)} ms`);
      }
      if (n.confidence) {
        lines.push(`Invocation count: ${n.confidence}`);
      }
      if (n.line > 0) {
        lines.push(n.endLine > n.line ? `Lines ${n.line}-${n.endLine}` : `Line ${n.line}`);
      }
      if (n.estimated) {
        lines.push("Includes modeled assumptions.");
      }
      return lines.join("\n");
    },
    onSelect: (n) => {
      // A shader-stage frame is an ablation target directly. A draw frame
      // carries its stages too, because an unweighted stage frame has zero
      // width and gets culled before it can be clicked — fragment stages start
      // out that way, and they're the interesting ones.
      if (n.module && n.stage) {
        setAblationTarget(n);
      } else if (n.ablationTargets?.length) {
        setAblationTarget(
          n.ablationTargets.find((t) => t.stage === "fragment") ?? n.ablationTargets[0]);
      }
      if (n.command && options.onSelectCommand) {
        options.onSelectCommand(n.command);
      }
    },
  });
  graph.element.style.minHeight = "260px";

  const statementPanel = new Div(panel, { class: "flame-statements" });
  const notes = new Div(panel, { class: "flame-notes" });

  function update() {
    const result = buildFrameCostTree({
      commands: options.commands,
      getObject: options.getObject,
      fragmentCounts,
      drawTimings,
      perDraw,
    });
    units = result.units;
    groups = result.groups;
    graph.setData(result.root);

    const unitNote = units === MS
      ? "measured GPU time, modeled split"
      : "modeled op units (no pass timings in this capture)";
    summary.element.textContent =
      `${result.stats.passes} pass(es) — ${formatCostValue(result.root.totalCost, units)} — ${unitNote}`;

    notes.element.innerHTML = "";
    for (const warning of result.warnings) {
      new Div(notes, { class: "flame-note", text: warning });
    }

    const canMeasure = !!(options.getDevice && options.database && options.getTextureFromAttachment);
    if (!canMeasure) {
      measureButton.element.title = "Fragment measurement needs a WebGPU device in DevTools.";
    }
    measureButton.disabled = measuring || !canMeasure || groups.length === 0;

    // Timing additionally needs the timestamp-query feature on the DevTools
    // device; say which of the two is missing rather than just greying out.
    const timing = canMeasure ? detectTimingSupport(options.getDevice()) : null;
    if (!canMeasure) {
      timeButton.element.title = "Draw timing needs a WebGPU device in DevTools.";
    } else if (!timing.supported) {
      timeButton.element.title = timing.reason;
    } else {
      timeButton.element.title =
        `Replay each draw with timestamp queries (${timing.method}), so every draw's width is measured time rather than a modeled share of its pass.`;
    }
    timeButton.disabled = measuring || !canMeasure || !timing?.supported;

    // Ablation needs a selected stage frame as well as a capable device.
    const canAblate = canMeasure && timing?.supported && ablationTarget &&
      (ablationTarget.stage === "vertex" || ablationTarget.stage === "fragment");
    ablateButton.disabled = measuring || !canAblate;
  }

  // The shader-stage frame most recently clicked, if any. Ablation is per-draw
  // and fairly expensive, so it's an explicit action on a chosen target rather
  // than something run across the frame.
  let ablationTarget = null;

  function setAblationTarget(node) {
    ablationTarget = node;
    const canAblate = !!(options.getDevice && options.database && options.getTextureFromAttachment) &&
      (node.stage === "vertex" || node.stage === "fragment");
    ablateButton.disabled = measuring || !canAblate;
    if (node.stage === "compute") {
      ablateButton.element.title = "Statement measurement currently covers vertex and fragment stages only.";
    } else if (canAblate) {
      const which = node.drawCount > 1
        ? ` (the first of ${node.drawCount} draws in this group)`
        : "";
      ablateButton.element.title =
        `Measure per-statement cost of ${node.stage} "${node.entryPoint ?? "?"}"${which}.`;
    }
  }

  function renderStatements(target, result) {
    statementPanel.element.innerHTML = "";
    if (!result.ok) {
      new Div(statementPanel, { class: "flame-note", text: `Statement measurement failed: ${result.reason}` });
      return;
    }

    const header = new Div(statementPanel, { class: "flame-statements-header" });
    const which = target.drawCount > 1 ? ` — first of ${target.drawCount} draws` : "";
    header.element.textContent =
      `${target.stage} "${target.entryPoint ?? "?"}"${which}: ${result.totalMs.toFixed(4)} ms total, ` +
      `${result.baselineMs.toFixed(4)} ms before the first statement` +
      (result.repeats > 1 ? `, ${result.repeats}x repeated` : "");

    // Ranked by cost: the point is finding the expensive line.
    const ranked = result.statements.slice().sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity));
    const maxMs = Math.max(...ranked.map((s) => s.ms ?? 0), 0);

    for (const statement of ranked) {
      const row = new Div(statementPanel, { class: "flame-statement" });

      const lineText = `line ${statement.line}`;
      if (options.onSelectShaderLine && target.module) {
        const link = new Span(row, { class: "perf-line-link", text: lineText });
        link.element.onclick = () => options.onSelectShaderLine(target.module, statement.line);
      } else {
        new Span(row, { class: "flame-statement-line", text: lineText });
      }

      // A share bar, so the ranking reads at a glance.
      const barWrap = new Div(row, { class: "flame-statement-bar" });
      const width = maxMs > 0 && statement.ms > 0 ? (statement.ms / maxMs) * 100 : 0;
      new Div(barWrap, { class: "flame-statement-fill", style: `width: ${width}%;` });

      const cost = statement.ms === null
        ? "not measured"
        : statement.negative
          ? "too small to measure"
          : `${statement.ms.toFixed(4)} ms`;
      new Span(row, { class: "flame-statement-cost", text: cost });
      new Span(row, { class: "flame-statement-src", text: statement.label });
    }
  }

  async function measureStatements() {
    if (measuring || !ablationTarget) {
      return;
    }
    const device = options.getDevice?.();
    if (!device) {
      new Div(notes, { class: "flame-note", text: "Statement measurement is unavailable: no DevTools GPU device." });
      return;
    }
    const target = ablationTarget;
    measuring = true;
    ablateButton.disabled = true;
    statementPanel.element.innerHTML = "";

    try {
      const result = await measureStatementCosts({
        device,
        database: options.database,
        commands: options.commands,
        getTextureFromAttachment: options.getTextureFromAttachment,
        drawCommand: target.command,
        stage: target.stage,
        entryPoint: target.entryPoint,
        onProgress: (done, total) => {
          ablateButton.text = `Cut ${done}/${total}...`;
        },
      });
      renderStatements(target, result);
      for (const note of result.notes ?? []) {
        new Div(statementPanel, { class: "flame-note", text: note });
      }
    } catch (e) {
      new Div(statementPanel, { class: "flame-note", text: `Statement measurement failed: ${e.message ?? e}` });
    } finally {
      measuring = false;
      ablateButton.text = "Measure statements";
      setAblationTarget(target);
      update();
    }
  }

  async function measureTimings() {
    if (measuring) {
      return;
    }
    const device = options.getDevice?.();
    if (!device) {
      new Div(notes, { class: "flame-note", text: "Draw timing is unavailable: no DevTools GPU device." });
      return;
    }
    measuring = true;
    timeButton.disabled = true;
    measureButton.disabled = true;

    const measureNotes = [];
    let measured = false;
    try {
      const result = await measureDrawTimings({
        device,
        database: options.database,
        commands: options.commands,
        getTextureFromAttachment: options.getTextureFromAttachment,
        onProgress: (done, total) => {
          timeButton.text = `Timing ${done}/${total}...`;
        },
      });
      drawTimings = result.timings;
      measured = true;
      measureNotes.push(...result.notes);
      if (result.skipped) {
        measureNotes.push(`${result.skipped} draw(s) could not be replayed for timing and keep their modeled cost.`);
      }
    } catch (e) {
      measureNotes.push(`Draw timing failed: ${e.message ?? e}`);
    } finally {
      measuring = false;
      timeButton.text = measured ? "Re-measure draw times" : "Measure draw times";
      update();
      for (const note of measureNotes) {
        new Div(notes, { class: "flame-note", text: note });
      }
    }
  }

  async function measureFragments() {
    if (measuring) {
      return;
    }
    const device = options.getDevice?.();
    if (!device) {
      new Div(notes, { class: "flame-note", text: "Fragment measurement is unavailable: no DevTools GPU device." });
      return;
    }
    measuring = true;
    measureButton.disabled = true;
    measureButton.text = "Measuring...";

    const counts = new Map();
    const measureNotes = [];
    let measured = false;
    try {
      // Each group is measured against the render target it draws into, so the
      // replay's pass collection can find it. Bucket the groups by target.
      const byTarget = new Map();
      for (const group of groups) {
        const attachment = group.pass.command.args?.[0]?.colorAttachments?.[0];
        const texture = attachment ? options.getTextureFromAttachment(attachment) : null;
        if (!texture) {
          measureNotes.push("A render pass has no resolvable color attachment; its fragment counts were not measured.");
          continue;
        }
        let bucket = byTarget.get(texture.id);
        if (!bucket) {
          bucket = { texture, groups: [] };
          byTarget.set(texture.id, bucket);
        }
        bucket.groups.push({ key: group.key, draws: group.draws });
      }

      for (const bucket of byTarget.values()) {
        const result = await measureFragmentCounts({
          device,
          database: options.database,
          commands: options.commands,
          targetTexture: bucket.texture,
          getTextureFromAttachment: options.getTextureFromAttachment,
          groups: bucket.groups,
        });
        for (const [key, value] of result.results) {
          counts.set(key, value.fragments);
        }
        measureNotes.push(...result.notes);
        if (result.skippedDraws) {
          measureNotes.push(`${result.skippedDraws} draw(s) could not be replayed and are missing from the fragment counts.`);
        }
      }
      fragmentCounts = counts;
      measured = true;
    } catch (e) {
      measureNotes.push(`Fragment measurement failed: ${e.message ?? e}`);
    } finally {
      measuring = false;
      measureButton.text = "Measure fragments";
      update();
      if (measured) {
        measureNotes.push("Fragment counts are rasterized fragments, counted before the depth test — an upper bound on fragment shader invocations wherever early-Z is rejecting work.");
      }
      for (const note of measureNotes) {
        new Div(notes, { class: "flame-note", text: note });
      }
    }
  }

  update();
  return panel;
}
