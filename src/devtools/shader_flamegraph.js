import { collapsible } from "./widget/collapsible.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Select } from "./widget/select.js";
import { Checkbox } from "./widget/checkbox.js";
import { Button } from "./widget/button.js";
import { FlameGraph } from "./widget/flamegraph.js";
import { getShaderCostTree } from "./shader_cost.js";
import {
  mergeCostTree,
  dominantDimension,
  DefaultCostWeights,
  CostDimensions,
} from "wgsl_reflect/wgsl_reflect.module.js";

export { getShaderCostTree };

const DIMENSION_LABEL = {
  alu: "ALU",
  sfu: "SFU / transcendental",
  texture: "Texture",
  memory: "Buffer memory",
};

/** Color a frame by whichever cost dimension dominates its subtree. */
function colorByDimension(node) {
  const dim = node.total ? dominantDimension(node.total) : null;
  return FlameGraph.dimensionColors[dim] ?? FlameGraph.kindColors[node.kind] ?? "#4a8db8";
}

function formatOps(value) {
  if (value >= 10000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  if (value >= 100) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}

/** "58% texture, 31% ALU" — the mix of a frame's total cost. */
function dimensionBreakdown(cost, weights = DefaultCostWeights) {
  const parts = [];
  let total = 0;
  for (const d of CostDimensions) {
    total += (cost[d] ?? 0) * weights[d];
  }
  if (total <= 0) {
    return "";
  }
  for (const d of CostDimensions) {
    const share = ((cost[d] ?? 0) * weights[d]) / total;
    if (share >= 0.05) {
      parts.push(`${(share * 100).toFixed(0)}% ${DIMENSION_LABEL[d]}`);
    }
  }
  return parts.join(", ");
}

function tooltipFor(node, unitLabel) {
  const lines = [node.name];
  lines.push(`Total: ${formatOps(node.totalCost)} ${unitLabel}`);
  if (node.selfCost > 0) {
    lines.push(`Self: ${formatOps(node.selfCost)} ${unitLabel}`);
  }
  if (node.line > 0) {
    lines.push(node.endLine > node.line ? `Lines ${node.line}-${node.endLine}` : `Line ${node.line}`);
  }
  if (node.kind === "loop") {
    lines.push(`Iterations: ${node.iterations}${node.iterationsKnown ? "" : " (assumed)"}`);
  }
  const mix = node.total ? dimensionBreakdown(node.total) : "";
  if (mix) {
    lines.push(mix);
  }
  if (node.estimated) {
    lines.push("Includes modeled assumptions (unbounded loop or branch split).");
  }
  return lines.join("\n");
}

function addLegend(parent) {
  const row = new Div(parent, { class: "flame-legend" });
  new Span(row, { class: "flame-legend-label", text: "Cost:" });
  for (const d of CostDimensions) {
    const item = new Div(row, { class: "flame-legend-item" });
    new Span(item, {
      class: "flame-legend-swatch",
      style: `background: ${FlameGraph.dimensionColors[d]};`,
    });
    new Span(item, { text: DIMENSION_LABEL[d] });
  }
  return row;
}

/**
 * Render a flame graph of a shader's modeled per-invocation cost, with an entry
 * point selector.
 *
 * This is a static model: it estimates instruction mix from the AST and cannot
 * see the driver's optimizer, occupancy, or divergence. Frame widths are
 * comparable *within* one shader; use the frame-level graph to compare shaders
 * against real invocation counts and measured pass times.
 *
 * @param {Widget} parent
 * @param {Object} shaderModule
 * @param {Object} [options]
 * @param {(line:number)=>void} [options.onLineClick] - jump the editor to a line
 * @param {number} [options.height=220] - graph height in px
 * @returns {Widget} the container Div
 */
export function addShaderFlameGraphPanel(parent, shaderModule, options = {}) {
  const result = getShaderCostTree(shaderModule);
  const panel = new Div(parent, { class: "flame-panel" });

  if (!result.entries.length) {
    new Div(panel, {
      class: "flame-empty",
      text: result.warnings.length
        ? result.warnings[0]
        : "No entry points found in this shader module.",
    });
    return panel;
  }

  const controls = new Div(panel, { class: "flame-controls" });

  let entryIndex = 0;
  let merged = true;

  const entryNames = result.entries.map((e) => `${e.stage}: ${e.name}`);
  const entrySelect = new Select(controls, {
    options: entryNames,
    index: 0,
    style: "min-width: 180px;",
  });

  new Checkbox(controls, {
    label: "Merge repeats",
    checked: true,
    onChange: (checked) => {
      merged = checked;
      update();
    },
  });

  const resetButton = new Button(controls, {
    label: "Reset zoom",
    class: "btn",
    callback: () => graph.resetZoom(),
  });
  resetButton.element.title = "Zoom back out to the whole entry point";

  const summary = new Div(panel, { class: "flame-summary" });
  addLegend(panel);

  const graph = new FlameGraph(panel, {
    formatValue: (n) => `${formatOps(n.totalCost)} ops`,
    colorOf: colorByDimension,
    tooltipOf: (n) => tooltipFor(n, "ops"),
    onSelect: (n) => {
      if (options.onLineClick && n.line > 0) {
        options.onLineClick(n.line);
      }
    },
  });
  graph.element.style.height = `${options.height ?? 220}px`;

  const notes = new Div(panel, { class: "flame-notes" });

  function update() {
    const entry = result.entries[entryIndex];
    const root = merged ? mergeCostTree(entry.root, result.weights) : entry.root;
    graph.setData(root);

    const mix = dimensionBreakdown(entry.cost, result.weights);
    const wg = entry.workgroupSize
      ? ` · workgroup ${entry.workgroupSize.join("x")} (${entry.workgroupSize[0] * entry.workgroupSize[1] * entry.workgroupSize[2]} threads)`
      : "";
    summary.element.textContent =
      `${formatOps(entry.costPerInvocation)} modeled ops per ${entry.stage} invocation${wg}` +
      (mix ? ` — ${mix}` : "");

    notes.element.innerHTML = "";
    for (const warning of result.warnings) {
      new Div(notes, { class: "flame-note", text: warning });
    }
  }

  entrySelect.onChange.addListener((_value, index) => {
    entryIndex = index;
    update();
  });

  update();
  return panel;
}

/**
 * Collapsible wrapper for the shader inspect panel.
 * @returns {collapsible}
 */
export function addShaderFlameGraphView(parent, shaderModule, options = {}) {
  const result = getShaderCostTree(shaderModule);
  const label = options.label ?? "Shader Cost (modeled)";
  const grp = new collapsible(parent, {
    collapsed: options.collapsed ?? true,
    label: result.entries.length ? `${label} — ${result.entries.length} entry point(s)` : label,
  });
  // The flame graph measures its frames as percentages of the container, so it
  // has to be laid out while visible. Build it the first time the group is
  // expanded rather than up front (also keeps a collapsed group cheap).
  let built = false;
  const build = () => {
    if (built) {
      return;
    }
    built = true;
    addShaderFlameGraphPanel(grp.body, shaderModule, options);
  };
  if (!grp.collapsed) {
    build();
  }
  grp.onExpanded.addListener(build);
  return grp;
}
