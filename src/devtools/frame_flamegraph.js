import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Checkbox } from "./widget/checkbox.js";
import { Button } from "./widget/button.js";
import { FlameGraph } from "./widget/flamegraph.js";
import { buildFrameCostTree, formatCostValue, MS, OPS } from "./frame_cost_tree.js";
import { measureFragmentCounts } from "./capture_replay.js";
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
  let measuring = false;
  let units = OPS;
  let groups = [];

  const controls = new Div(panel, { class: "flame-controls" });
  new Checkbox(controls, {
    label: "Per draw",
    checked: false,
    onChange: (checked) => {
      perDraw = checked;
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
      if (n.durationMs !== undefined && n.durationMs !== null) {
        lines.push(`Measured GPU time: ${n.durationMs.toFixed(3)} ms`);
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
      if (n.command && options.onSelectCommand) {
        options.onSelectCommand(n.command);
      }
    },
  });
  graph.element.style.minHeight = "260px";

  const notes = new Div(panel, { class: "flame-notes" });

  function update() {
    const result = buildFrameCostTree({
      commands: options.commands,
      getObject: options.getObject,
      fragmentCounts,
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
