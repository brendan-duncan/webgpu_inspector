import { collapsible } from "./widget/collapsible.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Checkbox } from "./widget/checkbox.js";
import { Widget } from "./widget/widget.js";
import { analyzePerformance } from "wgsl_reflect/wgsl_reflect.module.js";

// Severity ranking, worst first, used to find the worst finding in a set and to
// pick a badge color.
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };
const SEVERITY_LABEL = { high: "High", medium: "Med", low: "Low", info: "Info" };

/**
 * Run the static performance analysis on a ShaderModule, caching the result on
 * the module so re-inspecting (or showing it in multiple surfaces) doesn't
 * re-parse. The cache is keyed on the current code, so editing a shader's
 * replacementCode invalidates it automatically.
 * @param {Object} shaderModule
 * @returns {{ findings: Array }}
 */
export function getShaderAnalysis(shaderModule) {
  const code = shaderModule?.code ?? "";
  if (shaderModule._perfAnalysis && shaderModule._perfAnalysisCode === code) {
    return shaderModule._perfAnalysis;
  }
  let result;
  try {
    result = analyzePerformance(code);
  } catch (e) {
    result = { findings: [] };
  }
  shaderModule._perfAnalysis = result;
  shaderModule._perfAnalysisCode = code;
  return result;
}

function worstSeverity(findings) {
  let worst = "info";
  for (const f of findings) {
    if ((SEVERITY_RANK[f.severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0)) {
      worst = f.severity;
    }
  }
  return worst;
}

function severityCounts(findings) {
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (counts[f.severity] !== undefined) {
      counts[f.severity]++;
    }
  }
  return counts;
}

// "1 high, 2 medium" — only the non-zero buckets, worst first.
function summaryText(findings) {
  const counts = severityCounts(findings);
  const parts = [];
  for (const sev of ["high", "medium", "low", "info"]) {
    if (counts[sev]) {
      parts.push(`${counts[sev]} ${sev}`);
    }
  }
  return parts.join(", ");
}

/**
 * Render a single finding row into `parent`.
 * @param {Widget} parent
 * @param {Object} finding
 * @param {(line:number)=>void} [onLineClick] - if given, the line becomes a link
 */
function addFinding(parent, finding, onLineClick) {
  const row = new Div(parent, { class: ["perf-finding", `perf-row-${finding.severity}`] });
  if (finding.confidence && finding.confidence !== "high") {
    row.classList.add("perf-lowconf");
  }

  const head = new Div(row, { class: "perf-finding-head" });
  new Span(head, { class: `perf-badge perf-${finding.severity}`, text: finding.severity.toUpperCase() });
  new Span(head, { class: "perf-rule", text: finding.rule });

  const lineText = `line ${finding.line}`;
  if (onLineClick) {
    const link = new Span(head, { class: "perf-line-link", text: lineText });
    link.element.onclick = () => onLineClick(finding.line);
  } else {
    new Span(head, { class: "perf-line", text: lineText });
  }

  new Div(row, { class: "perf-msg", text: finding.message });

  const meta = [];
  if (finding.function) {
    meta.push(`fn ${finding.function}`);
  }
  if (finding.stage) {
    meta.push(finding.stage);
  }
  if (finding.loopDepth) {
    meta.push(`loop depth ${finding.loopDepth}`);
  }
  if (finding.confidence) {
    meta.push(`${finding.confidence} confidence`);
  }
  new Div(row, { class: "perf-finding-meta", text: meta.join(" · ") });
}

/**
 * Render the findings list with a Low/Med/High severity filter above it. Only
 * severities actually present get a toggle, and the filter row is omitted when
 * there's only one severity (nothing to filter).
 * @param {Widget} parent
 * @param {Array} findings - pre-sorted by score
 * @param {(line:number)=>void} [onLineClick]
 */
function addFindingsList(parent, findings, onLineClick) {
  // Always offer High/Med/Low so the filter is discoverable; add Info only when
  // there are info-level findings to filter.
  const toggles = ["high", "medium", "low"];
  if (findings.some((f) => f.severity === "info")) {
    toggles.push("info");
  }

  let list;
  const filterRow = new Div(parent, { class: "perf-filter-row" });
  new Span(filterRow, { class: "perf-filter-label", text: "Show:" });
  for (const sev of toggles) {
    new Checkbox(filterRow, {
      label: SEVERITY_LABEL[sev],
      checked: true,
      onChange: (checked) => {
        list.element.classList.toggle(`perf-hide-${sev}`, !checked);
      },
    });
  }

  list = new Div(parent, { class: "perf-findings" });
  for (const finding of findings) {
    addFinding(list, finding, onLineClick);
  }
  return list;
}

/**
 * Add an inline "Performance Analysis" collapsible for a shader module. The
 * findings come pre-sorted by score (worst first) from the analyzer.
 * @param {Widget} parent
 * @param {Object} shaderModule
 * @param {Object} [options]
 * @param {string} [options.label="Performance Analysis"]
 * @param {boolean} [options.collapsed]
 * @param {(line:number)=>void} [options.onLineClick] - makes line numbers clickable
 * @returns {collapsible}
 */
export function addShaderAnalysisView(parent, shaderModule, options = {}) {
  const result = getShaderAnalysis(shaderModule);
  const findings = result.findings ?? [];

  const baseLabel = options.label ?? "Performance Analysis";
  const label = findings.length
    ? `${baseLabel} (${findings.length}) — ${summaryText(findings)}`
    : baseLabel;

  // Default: expand when there are findings, collapse when clean, unless the
  // caller forces a state.
  const collapsed = options.collapsed ?? findings.length === 0;
  const grp = new collapsible(parent, { collapsed, label });
  grp.titleBar.classList.add(`perf-title-${worstSeverity(findings)}`);

  if (!findings.length) {
    new Div(grp.body, { class: "perf-empty", text: "No performance issues found." });
    return grp;
  }

  addFindingsList(grp.body, findings, options.onLineClick);
  return grp;
}

// "3 draw calls, 1 dispatch" — pluralized, empty when unused.
function usageText(usage) {
  if (!usage) {
    return "";
  }
  const parts = [];
  if (usage.draws) {
    parts.push(`${usage.draws} draw call${usage.draws === 1 ? "" : "s"}`);
  }
  if (usage.dispatches) {
    parts.push(`${usage.dispatches} dispatch${usage.dispatches === 1 ? "" : "es"}`);
  }
  return parts.join(", ");
}

/**
 * Build a frame-wide shader performance report over a collection of shader
 * modules, as a standalone scrollable panel (intended to be added as a tab).
 * @param {Iterable<Object>} shaderModules
 * @param {Object} [options]
 * @param {(shaderModule:Object)=>void} [options.onInspect] - "Inspect" jump per module
 * @param {(shaderModule:Object, line:number)=>void} [options.onLineClick] - per-finding line jump
 * @param {Map<number,{draws:number,dispatches:number}>} [options.usage] - per-module frame usage
 * @returns {Widget} a Div panel
 */
export function buildFrameShaderAnalysis(shaderModules, options = {}) {
  const usage = options.usage;
  const panel = new Div(null, { class: "perf-report", style: "width: 100%; height: 100%; overflow: auto;" });

  // Collect per-module results, skipping clean modules, and rank modules by
  // their worst finding so the most problematic float to the top.
  const modules = [];
  let cleanCount = 0;
  let total = 0;
  for (const module of shaderModules) {
    const findings = getShaderAnalysis(module).findings ?? [];
    if (!findings.length) {
      cleanCount++;
      continue;
    }
    total += findings.length;
    modules.push({ module, findings });
  }

  modules.sort((a, b) => {
    const sa = SEVERITY_RANK[worstSeverity(a.findings)] ?? 0;
    const sb = SEVERITY_RANK[worstSeverity(b.findings)] ?? 0;
    if (sb !== sa) {
      return sb - sa;
    }
    return b.findings.length - a.findings.length;
  });

  const header = new Div(panel, { class: "perf-report-header" });
  if (!modules.length) {
    new Div(header, { text: `No performance issues found across ${cleanCount} shader module(s).` });
    return panel;
  }
  new Div(header, {
    text: `${total} issue(s) in ${modules.length} of ${modules.length + cleanCount} shader module(s).`,
  });

  for (const { module, findings } of modules) {
    const stages = [];
    if (module.hasVertexEntries) { stages.push("vertex"); }
    if (module.hasFragmentEntries) { stages.push("fragment"); }
    if (module.hasComputeEntries) { stages.push("compute"); }
    const stageStr = stages.length ? ` (${stages.join("/")})` : "";
    // Prefer the shader's label; fall back to the module id.
    const name = module.label ? `"${module.label}"` : `Module ID:${module.id}`;
    const used = usageText(usage?.get(module.id));
    const usedStr = used ? ` — ${used}` : "";
    const moduleLabel = `${name}${stageStr}${usedStr} — ${summaryText(findings)}`;

    const grp = new collapsible(panel, { collapsed: true, label: moduleLabel });
    grp.titleBar.classList.add(`perf-title-${worstSeverity(findings)}`);

    const metaRow = new Div(grp.body, { class: "perf-inspect-row" });
    if (options.onInspect) {
      const link = new Span(metaRow, { class: "perf-line-link", text: "Inspect shader" });
      link.element.onclick = () => options.onInspect(module);
    }
    new Span(metaRow, {
      class: "perf-usage",
      text: used ? `Used in ${used}` : "Not used in this frame",
    });

    const onLineClick = options.onLineClick
      ? (line) => options.onLineClick(module, line)
      : undefined;
    addFindingsList(grp.body, findings, onLineClick);
  }

  return panel;
}
