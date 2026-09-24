import { Checkbox } from "./widget/checkbox.js";
import { Div } from "./widget/div.js";
import { Select } from "./widget/select.js";
import { Span } from "./widget/span.js";

const SEVERITY_LABEL = { high: "High", medium: "Med", low: "Low", info: "Info" };
const ALL_RULES = "All rules";

/**
 * The Frame Issues report: every finding of analyzeFrameIssues, most severe
 * first, filterable by severity and rule. Each finding's "Go to" link steps
 * through the commands it was raised on.
 *
 * @param {{findings: Object[]}} result - from analyzeFrameIssues
 * @param {Object} options
 * @param {(command:Object)=>void} options.onSelectCommand - jump to a command in the command list
 * @returns {Div}
 */
export function buildFrameIssuesView(result, options) {
  const findings = result.findings;
  const panel = new Div(null, { class: "frame-issues" });

  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity]++;
  }
  const summary = findings.length
    ? `${findings.length} issue${findings.length === 1 ? "" : "s"}: ` +
      ["high", "medium", "low", "info"].filter((s) => counts[s]).map((s) => `${counts[s]} ${SEVERITY_LABEL[s].toLowerCase()}`).join(", ")
    : "No issues found in this frame.";
  new Div(panel, { class: "perf-report-header", text: summary });
  if (!findings.length) {
    return panel;
  }

  let list = null;
  const filterRow = new Div(panel, { class: "perf-filter-row" });
  new Span(filterRow, { class: "perf-filter-label", text: "Show:" });
  for (const sev of ["high", "medium", "low", "info"]) {
    if (!counts[sev] && sev === "info") {
      continue;
    }
    new Checkbox(filterRow, {
      label: SEVERITY_LABEL[sev],
      checked: true,
      onChange: (checked) => list.element.classList.toggle(`perf-hide-${sev}`, !checked),
    });
  }
  const rules = [ALL_RULES, ...new Set(findings.map((f) => f.rule))];
  const ruleSelect = new Select(filterRow, { options: rules, style: "width: 220px;" });
  ruleSelect.onChange.addListener((value) => {
    for (const row of rows) {
      row.widget.element.style.display = value === ALL_RULES || row.finding.rule === value ? "" : "none";
    }
  });

  list = new Div(panel, { class: "perf-findings" });
  const rows = [];
  for (const finding of findings) {
    const row = new Div(list, { class: `perf-finding perf-row-${finding.severity}${finding.confidence === "low" ? " perf-lowconf" : ""}` });
    rows.push({ widget: row, finding });
    const head = new Div(row, { class: "perf-finding-head" });
    new Span(head, { class: `perf-badge perf-${finding.severity}`, text: finding.severity.toUpperCase() });
    new Span(head, { class: "perf-rule", text: finding.rule });
    if (finding.count > 1) {
      new Span(head, { class: "perf-line", text: `×${finding.count}` });
    }
    const commands = finding.commands.filter((c) => c);
    if (commands.length) {
      let next = 0;
      const link = new Span(head, { class: "perf-line-link", text: "Go to command" });
      link.tooltip = commands.length > 1
        ? "Select the command in the command list. Click again for the next one."
        : "Select the command in the command list";
      link.element.onclick = () => {
        const command = commands[next];
        options.onSelectCommand?.(command);
        if (commands.length > 1) {
          link.text = `Go to next (${next + 1} of ${commands.length})`;
        }
        next = (next + 1) % commands.length;
      };
    }
    new Div(row, { class: "perf-msg", text: finding.message });
    if (finding.confidence !== "high") {
      new Div(row, { class: "perf-finding-meta", text: `${finding.confidence} confidence` });
    }
  }
  return panel;
}

/**
 * Mark the command-list rows that findings were raised on: a small badge in
 * the most severe finding's color, with every finding's rule in its tooltip.
 * @param {Map<Object, Object[]>} byCommand - from analyzeFrameIssues
 * @param {(command:Object)=>void} onClick - e.g. open the Frame Issues report
 */
export function markCommandIssues(byCommand, onClick) {
  const rank = { high: 3, medium: 2, low: 1, info: 0 };
  for (const [command, list] of byCommand) {
    const element = command?.widget?.element;
    if (!element || element.querySelector(":scope > .frame-issue-marker")) {
      continue;
    }
    let worst = list[0];
    for (const f of list) {
      if (rank[f.severity] > rank[worst.severity]) {
        worst = f;
      }
    }
    const marker = document.createElement("span");
    marker.className = `frame-issue-marker frame-issue-${worst.severity}`;
    marker.textContent = "!";
    marker.title = [...new Set(list.map((f) => `${f.severity.toUpperCase()}: ${f.rule}`))].join("\n");
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick?.(command);
    });
    element.insertBefore(marker, element.firstChild);
  }
}
