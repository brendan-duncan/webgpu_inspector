import { Button } from "./widget/button.js";
import { Checkbox } from "./widget/checkbox.js";
import { Div } from "./widget/div.js";
import { Select } from "./widget/select.js";
import { Span } from "./widget/span.js";
import { TextInput } from "./widget/text_input.js";
import { analyzeRenderGraph, groupResourceRows, usageClass } from "./render_graph.js";

/**
 * The Render Graph view: a captured frame drawn as the passes it ran and the
 * resources that tie them together (render_graph.js builds the graph).
 *
 * A node-link diagram of a whole frame is a hairball once it has more than a
 * few dozen passes, so the main view is a resource lifetime chart instead —
 * passes along the top in execution order, one row per texture or buffer, a
 * bar across the passes where the resource is live, marked where each pass
 * reads or writes it. It scales to any frame and needs no layout pass.
 *
 * The node-link drawing is kept where it is readable: the neighborhood of the
 * selected pass, its producers on the left and consumers on the right.
 */

// Column widths in pixels, by the zoom control's label; "Fit" divides the panel between the passes.
const ZOOM = { "Fit": 0, "Small": 8, "Medium": 16, "Large": 28 };
const ROW_HEIGHT = 18;
const LABEL_WIDTH = 240;
const MIN_COLUMN = 3;
const MAX_FIT_COLUMN = 240;
const NAMED_COLUMN = 56;
const MAX_DETAIL_USES = 40;

/**
 * @param {Object} graph - from buildFrameRenderGraph
 * @param {Object} options
 * @param {(command:Object)=>void} options.onSelectCommand - jump to a command in the command list
 * @param {(object:Object)=>void} options.onInspect - show an object in the Inspect panel
 * @returns {Div} the panel
 */
export function buildRenderGraphView(graph, options) {
  return new RenderGraphView(graph, options).panel;
}

class RenderGraphView {
  constructor(graph, options) {
    this._graph = graph;
    this._options = options;
    this._rows = groupResourceRows(graph.resources);
    this._filter = "";
    this._showTextures = true;
    this._showBuffers = true;
    // Vertex, index, indirect and uniform buffers: real edges, but a frame has
    // one per draw and they bury the render targets the graph is read for.
    this._showInputs = false;
    this._zoom = "Fit";
    this._selection = null;
    this._nodeCells = [];
    this._rowWidgets = new Map();

    this.panel = new Div(null, { class: "render-graph" });
    this._status = new Div(this.panel, { class: "render-graph-summary" });
    for (const warning of graph.warnings) {
      new Div(this.panel, { class: "flame-note", text: warning });
    }
    this._buildControls();
    this._suggestions = new Div(this.panel, { class: "render-graph-suggestions" });
    this._renderSuggestions();
    this._chart = new Div(this.panel, { class: "render-graph-chart" });
    this._detail = new Div(this.panel, { class: "render-graph-detail" });

    // "Fit" needs the chart's width, which is only known once the tab is in
    // the document; redraw when it first gets a size and on later resizes.
    this._lastWidth = 0;
    this._resizeObserver = new ResizeObserver(() => {
      const width = this._chart.element.clientWidth;
      if (width && width !== this._lastWidth) {
        this._lastWidth = width;
        this._draw();
      }
    });
    this._resizeObserver.observe(this._chart.element);
    this._draw();

    // Open on the frame's last presented write, which is what the frame is
    // for; failing that, the most expensive pass.
    const presented = [...graph.nodes].reverse().find((n) => n.writes.some((w) => w.resource.sink === "presented"));
    const costly = [...graph.nodes].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];
    const initial = presented ?? costly ?? graph.nodes[0];
    if (initial) {
      this._select({ kind: "node", node: initial });
    }
  }

  _renderSuggestions() {
    const { findings } = analyzeRenderGraph(this._graph);
    this._findings = findings;
    if (!findings.length) {
      new Div(this._suggestions, { class: "perf-empty", text: "No suggestions: the graph's rules found nothing to report about this frame's dependencies." });
      return;
    }
    new Div(this._suggestions, { class: "render-graph-heading", text: `Suggestions (${findings.length})` });
    const list = new Div(this._suggestions, { class: "perf-findings" });
    for (const f of findings) {
      const row = new Div(list, { class: `perf-finding perf-row-${f.severity}${f.confidence === "low" ? " perf-lowconf" : ""}` });
      const head = new Div(row, { class: "perf-finding-head" });
      new Span(head, { class: `perf-badge perf-${f.severity}`, text: f.severity.toUpperCase() });
      new Span(head, { class: "perf-rule", text: f.rule });
      if (f.node) {
        const node = f.node;
        const link = new Span(head, { class: "perf-line-link", text: node.label });
        link.tooltip = "Select the pass in the chart";
        link.element.onclick = () => this._select({ kind: "node", node });
      }
      if (f.count > 1) {
        new Span(head, { class: "perf-line", text: `×${f.count}` });
      }
      new Div(row, { class: "perf-msg", text: f.message });
      if (f.confidence !== "high") {
        new Div(row, { class: "perf-finding-meta", text: `${f.confidence} confidence` });
      }
    }
  }

  _buildControls() {
    const row = new Div(this.panel, { class: "flame-controls" });
    new Span(row, { class: "flame-legend-label", text: "Filter" });
    new TextInput(row, {
      placeholder: "resource...",
      style: "width: 140px;",
      onEdit: (value) => {
        this._filter = (value ?? "").trim().toLowerCase();
        this._draw();
      },
    });
    new Checkbox(row, { label: "Textures", checked: true, onChange: (checked) => { this._showTextures = checked; this._draw(); } });
    new Checkbox(row, { label: "Buffers", checked: true, onChange: (checked) => { this._showBuffers = checked; this._draw(); } });
    new Checkbox(row, {
      label: "Geometry & uniforms",
      checked: false,
      tooltip: "Vertex, index, indirect and uniform buffers. Real dependencies, but a frame has one per draw, and they bury the render targets the graph is usually read for.",
      onChange: (checked) => { this._showInputs = checked; this._draw(); },
    });
    new Span(row, { class: "flame-legend-label", text: "Zoom" });
    const zoom = new Select(row, { options: Object.keys(ZOOM), value: this._zoom, style: "width: 80px;" });
    zoom.onChange.addListener((value) => {
      this._zoom = value;
      this._draw();
    });
    if (this._graph.criticalPath.length) {
      const button = new Button(row, {
        label: "Critical path",
        class: "btn",
        callback: () => this._select({ kind: "node", node: this._graph.criticalPath[0] }),
      });
      button.tooltip = "Select the longest chain of dependent passes by GPU time";
    }
  }

  // ------------------------------------------------------------------ chart

  _visibleRows() {
    return this._rows.filter((r) => {
      if (r.type === "texture" && !this._showTextures) {
        return false;
      }
      if (r.type === "buffer" && !this._showBuffers) {
        return false;
      }
      if (!this._showInputs && r.uses.every((u) => usageClass(u.usage) === "input")) {
        return false;
      }
      if (this._filter && !r.label.toLowerCase().includes(this._filter) && !r.detail.toLowerCase().includes(this._filter)) {
        return false;
      }
      return true;
    });
  }

  _draw() {
    const graph = this._graph;
    const rows = this._visibleRows();
    this._nodeCells = [];
    this._rowWidgets = new Map();
    this._chart.html = "";

    const nodes = graph.nodes;
    const timed = nodes.filter((n) => n.durationMs !== null).length;
    const parts = [
      _plural(nodes.length, "pass", "passes"),
      _plural(this._rows.length, "resource"),
      _plural(graph.edges.length, "dependency", "dependencies"),
    ];
    if (timed) {
      parts.push(`${timed} timed`);
    }
    if (graph.criticalPathMs > 0) {
      parts.push(`critical path ${graph.criticalPathMs.toFixed(3)} ms through ${_plural(graph.criticalPath.length, "pass", "passes")}`);
    }
    const external = groupResourceRows(graph.externalInputs).length;
    if (external) {
      parts.push(`${external} read from before the frame`);
    }
    if (graph.unreadNodes.length) {
      parts.push(`${_plural(graph.unreadNodes.length, "pass", "passes")} nothing reads`);
    }
    this._status.text = parts.join(", ");

    if (!nodes.length) {
      new Div(this._chart, { class: "flame-empty", text: "No passes in this capture touch a resource the graph can name." });
      return;
    }
    if (!rows.length) {
      new Div(this._chart, { class: "flame-empty", text: "No resources match the filters." });
      return;
    }

    const available = Math.max(200, this._chart.element.clientWidth - LABEL_WIDTH - 16);
    const colW = this._zoom === "Fit"
      ? Math.min(MAX_FIT_COLUMN, Math.max(MIN_COLUMN, Math.floor(available / nodes.length)))
      : ZOOM[this._zoom];
    const trackWidth = colW * nodes.length;

    const scroller = new Div(this._chart, { class: "render-graph-scroll" });
    const grid = new Div(scroller, { class: "render-graph-grid", style: `width: ${LABEL_WIDTH + trackWidth}px;` });

    // Pass header: one cell per node, colored by kind, filled by GPU time
    // when the frame was timed so it doubles as a bar chart of the frame.
    const header = new Div(grid, { class: "render-graph-header" });
    new Div(header, { class: "render-graph-corner", text: `Passes (${nodes.length})`, style: `width: ${LABEL_WIDTH}px;` });
    const headerTrack = new Div(header, { class: "render-graph-header-track", style: `width: ${trackWidth}px;` });
    const maxMs = Math.max(0, ...nodes.map((n) => n.durationMs ?? 0));
    const onPath = new Set(graph.criticalPath);
    for (const node of nodes) {
      const cls = ["render-graph-pass", `render-graph-pass-${node.kind}`];
      if (node.unread) {
        cls.push("render-graph-unread");
      }
      if (onPath.has(node)) {
        cls.push("render-graph-onpath");
      }
      const cell = new Div(headerTrack, {
        class: cls.join(" "),
        style: `left: ${node.ordinal * colW}px; width: ${Math.max(1, colW - 1)}px;`,
      });
      if (maxMs > 0) {
        const share = Math.round(((node.durationMs ?? 0) / maxMs) * 100);
        new Div(cell, { class: "render-graph-pass-bar", style: `height: ${share}%;` });
      }
      if (colW >= NAMED_COLUMN) {
        new Span(cell, { class: "render-graph-pass-name", text: _ellipsis(node.label, Math.floor(colW / 6)) });
      }
      cell.tooltip = this._nodeTooltip(node);
      cell.element.onclick = () => this._select({ kind: "node", node });
      this._nodeCells.push(cell);
    }

    const body = new Div(grid, { class: "render-graph-body" });
    for (const resource of rows) {
      const row = new Div(body, { class: "render-graph-row", style: `height: ${ROW_HEIGHT}px;` });
      const label = new Div(row, { class: `render-graph-label render-graph-${resource.type}`, style: `width: ${LABEL_WIDTH}px;` });
      new Span(label, { class: "render-graph-name", text: resource.label });
      if (resource.detail) {
        new Span(label, { class: "render-graph-detail-text", text: resource.detail });
      }
      label.tooltip = this._resourceTooltip(resource);
      label.element.onclick = () => this._select({ kind: "resource", resource });

      const track = new Div(row, { class: "render-graph-track", style: `width: ${trackWidth}px;` });
      const first = resource.first * colW;
      const span = Math.max(colW, (resource.last - resource.first + 1) * colW);
      new Div(track, { class: "render-graph-life", style: `left: ${first}px; width: ${span}px;` });
      if (resource.externalInput || resource.hostInput) {
        const tick = new Div(track, { class: `render-graph-external${resource.externalInput ? "" : " render-graph-host"}`, style: `left: ${Math.max(0, first - 3)}px;` });
        tick.tooltip = resource.externalInput
          ? "Read before anything in the capture wrote it: the previous frame, or work outside the captured range."
          : "Read after a queue.writeBuffer / writeTexture upload in this capture.";
      }
      // One mark per pass: the uses of every subresource the pass touched.
      const byNode = new Map();
      for (const use of resource.uses) {
        let entry = byNode.get(use.node);
        if (!entry) {
          entry = { node: use.node, modes: new Set(), usages: new Set(), cls: usageClass(use.usage) };
          byNode.set(use.node, entry);
        }
        entry.modes.add(use.mode);
        entry.usages.add(use.usage);
      }
      for (const entry of byNode.values()) {
        const mode = entry.modes.size > 1 || entry.modes.has("readwrite") ? "readwrite" : [...entry.modes][0];
        const mark = new Div(track, {
          class: `render-graph-use render-graph-use-${mode} render-graph-usage-${entry.cls}`,
          style: `left: ${entry.node.ordinal * colW}px; width: ${Math.max(2, colW - 1)}px;`,
        });
        const verb = mode === "read" ? "reads" : mode === "write" ? "writes" : "reads and writes";
        mark.tooltip = `${entry.node.label}\n${verb} ${resource.label} as ${[...entry.usages].join(", ")}`;
        mark.element.onclick = () => this._select({ kind: "node", node: entry.node });
      }
      this._rowWidgets.set(resource.key, row);
    }
    this._applyHighlight();
    this._renderLegend();
  }

  _renderLegend() {
    const legend = new Div(this._chart, { class: "flame-legend render-graph-legend" });
    const items = [["attachment", "attachment"], ["sampled", "sampled"], ["storage", "storage"], ["transfer", "copy / upload"], ["input", "geometry / uniform"]];
    for (const [cls, text] of items) {
      const item = new Span(legend, { class: "flame-legend-item" });
      new Span(item, { class: `render-graph-swatch render-graph-usage-${cls}` });
      new Span(item, { text });
    }
    const item = new Span(legend, { class: "flame-legend-item" });
    new Span(item, { class: "render-graph-swatch render-graph-use-read render-graph-usage-other" });
    new Span(item, { text: "read (hollow) vs write (filled)" });
  }

  // -------------------------------------------------------------- selection

  _select(selection) {
    this._selection = selection;
    this._applyHighlight();
    this._renderDetail();
  }

  _rowKeyOf(resource) {
    return `${resource.type}:${resource.objectId}`;
  }

  _applyHighlight() {
    for (const cell of this._nodeCells) {
      cell.classList.remove("render-graph-selected", "render-graph-related");
    }
    for (const row of this._rowWidgets.values()) {
      row.classList.remove("render-graph-selected", "render-graph-related");
    }
    const selection = this._selection;
    if (!selection) {
      return;
    }
    if (selection.kind === "node") {
      this._nodeCells[selection.node.ordinal]?.classList.add("render-graph-selected");
      for (const edge of [...selection.node.inputs, ...selection.node.outputs]) {
        const other = edge.from === selection.node ? edge.to : edge.from;
        this._nodeCells[other.ordinal]?.classList.add("render-graph-related");
      }
      for (const use of [...selection.node.reads, ...selection.node.writes]) {
        this._rowWidgets.get(this._rowKeyOf(use.resource))?.classList.add("render-graph-related");
      }
      return;
    }
    this._rowWidgets.get(selection.resource.key)?.classList.add("render-graph-selected");
    for (const use of selection.resource.uses) {
      this._nodeCells[use.node.ordinal]?.classList.add("render-graph-related");
    }
  }

  _renderDetail() {
    this._detail.html = "";
    const selection = this._selection;
    if (!selection) {
      return;
    }
    if (selection.kind === "resource") {
      this._renderResourceDetail(selection.resource);
    } else {
      this._renderNodeDetail(selection.node);
    }
  }

  _renderNodeDetail(node) {
    const head = new Div(this._detail, { class: "render-graph-detail-head" });
    new Span(head, { class: "render-graph-heading", text: node.label });
    const jump = new Span(head, { class: "perf-line-link", text: "Go to command" });
    jump.tooltip = "Select the pass in the command list";
    jump.element.onclick = () => this._options.onSelectCommand?.(node.command);

    const facts = [
      node.kind === "transfer"
        ? "transfer"
        : _plural(node.draws, node.kind === "compute" ? "dispatch" : "draw", node.kind === "compute" ? "dispatches" : "draws"),
      node.durationMs !== null ? `${node.durationMs.toFixed(3)} ms` : "",
      node.pathMs > 0 ? `${node.pathMs.toFixed(3)} ms to the end of the frame` : "",
    ].filter(Boolean);
    new Div(this._detail, { class: "render-graph-facts", text: facts.join("  ·  ") });

    if (node.unread) {
      new Div(this._detail, {
        class: "flame-note",
        text: "Nothing later in this capture reads what this pass wrote, and none of it is presented or read back. It may still be read by the next frame, or through a binding the capture cannot see.",
      });
    }
    if (node.unresolvedReads) {
      new Div(this._detail, {
        class: "flame-note",
        text: `${_plural(node.unresolvedReads, "binding")} of this pass could not be resolved to a resource, so it may read more than is shown.`,
      });
    }
    this._renderNeighborhood(node);
    this._renderUses("Reads", node.reads);
    this._renderUses("Writes", node.writes);
  }

  /**
   * The node-link view, over the one part of the graph small enough to draw
   * as one: the selected pass, everything that feeds it and everything it
   * feeds, with the resource named on each edge.
   */
  _renderNeighborhood(node) {
    const producers = _dedupeEdges(node.inputs.map((e) => ({ node: e.from, label: e.version.resource.label, usage: e.usage })));
    const consumers = _dedupeEdges(node.outputs.map((e) => ({ node: e.to, label: e.version.resource.label, usage: e.usage })));
    if (!producers.length && !consumers.length) {
      new Div(this._detail, { class: "render-graph-facts", text: "No pass in this capture feeds this one, and none consumes it." });
      return;
    }
    const shownProducers = producers.slice(0, 8);
    const shownConsumers = consumers.slice(0, 8);
    const rows = Math.max(shownProducers.length, shownConsumers.length, 1);
    const rowH = 34;
    const height = rows * rowH + 12;
    const width = 780;
    const boxW = 170;
    const boxH = 26;
    const colX = [4, (width - boxW) / 2, width - boxW - 4];
    const centerY = height / 2 - boxH / 2;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "render-graph-dag");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));

    const box = (x, y, target, cls) => {
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", `render-graph-dag-node ${cls}`);
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(boxW));
      rect.setAttribute("height", String(boxH));
      rect.setAttribute("rx", "3");
      g.appendChild(rect);
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", String(x + boxW / 2));
      text.setAttribute("y", String(y + boxH / 2 + 4));
      text.setAttribute("text-anchor", "middle");
      text.textContent = _ellipsis(target.label, 26);
      g.appendChild(text);
      const title = document.createElementNS(svgNS, "title");
      title.textContent = this._nodeTooltip(target);
      g.appendChild(title);
      g.addEventListener("click", () => this._select({ kind: "node", node: target }));
      svg.appendChild(g);
    };

    const edge = (x1, y1, x2, y2, label) => {
      const path = document.createElementNS(svgNS, "path");
      const mid = (x1 + x2) / 2;
      path.setAttribute("d", `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
      path.setAttribute("class", "render-graph-dag-edge");
      svg.appendChild(path);
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", String(mid));
      text.setAttribute("y", String((y1 + y2) / 2 - 4));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "render-graph-dag-edge-label");
      text.textContent = _ellipsis(label, 26);
      const title = document.createElementNS(svgNS, "title");
      title.textContent = label;
      text.appendChild(title);
      svg.appendChild(text);
    };

    shownProducers.forEach((p, i) => {
      const y = 6 + i * rowH;
      edge(colX[0] + boxW, y + boxH / 2, colX[1], centerY + boxH / 2, `${p.label} (${p.usage})`);
      box(colX[0], y, p.node, "render-graph-dag-in");
    });
    shownConsumers.forEach((c, i) => {
      const y = 6 + i * rowH;
      edge(colX[1] + boxW, centerY + boxH / 2, colX[2], y + boxH / 2, `${c.label} (${c.usage})`);
      box(colX[2], y, c.node, "render-graph-dag-out");
    });
    box(colX[1], centerY, node, "render-graph-dag-self");
    this._detail.element.appendChild(svg);
    const hidden = (producers.length - shownProducers.length) + (consumers.length - shownConsumers.length);
    if (hidden) {
      new Div(this._detail, { class: "render-graph-facts", text: `${hidden} more neighbor${hidden === 1 ? "" : "s"} not drawn.` });
    }
  }

  _renderUses(title, uses) {
    if (!uses.length) {
      return;
    }
    new Div(this._detail, { class: "render-graph-subheading", text: `${title} (${uses.length})` });
    const list = new Div(this._detail, { class: "render-graph-list" });
    for (const use of uses.slice(0, MAX_DETAIL_USES)) {
      const resource = use.resource;
      const row = new Div(list, { class: "render-graph-list-row" });
      const name = new Span(row, { class: "render-graph-list-name dependency_link", text: resource.label });
      name.tooltip = "Show the object in the Inspect panel";
      name.element.onclick = () => resource.object && this._options.onInspect?.(resource.object);
      let from;
      if (use.mode === "read") {
        const producer = use.version.producer;
        from = producer ? `from ${producer.label}` : use.version.host ? "from a host upload" : "from before the frame";
      } else {
        const readers = use.version.readers.length;
        from = readers ? `read by ${_plural(readers, "pass", "passes")}` : (resource.sink ? resource.sink : "not read again");
      }
      new Span(row, { class: "render-graph-list-value", text: `${use.usage} · ${from}` });
    }
    if (uses.length > MAX_DETAIL_USES) {
      new Div(list, { class: "render-graph-facts", text: `... ${uses.length - MAX_DETAIL_USES} more` });
    }
  }

  _renderResourceDetail(row) {
    const head = new Div(this._detail, { class: "render-graph-detail-head" });
    new Span(head, { class: "render-graph-heading", text: row.label });
    if (row.object) {
      const inspect = new Span(head, { class: "perf-line-link", text: "Inspect" });
      inspect.element.onclick = () => this._options.onInspect?.(row.object);
    }
    const writes = row.subresources.reduce((n, r) => n + r.versions.filter((v) => v.producer).length, 0);
    const facts = [row.detail, row.sink ?? "", `${_plural(writes, "write")} in the frame`].filter(Boolean);
    new Div(this._detail, { class: "render-graph-facts", text: facts.join("  ·  ") });

    for (const resource of row.subresources) {
      new Div(this._detail, {
        class: "render-graph-subheading",
        text: row.subresources.length > 1 ? `${resource.label} versions` : "Versions",
      });
      const list = new Div(this._detail, { class: "render-graph-list" });
      for (const version of resource.versions) {
        if (!version.producer && !version.readers.length) {
          continue;
        }
        const item = new Div(list, { class: "render-graph-list-row" });
        const producer = version.producer;
        const source = producer ? producer.label : version.host ? "host upload" : "before the frame";
        const name = new Span(item, { class: `render-graph-list-name${producer ? " dependency_link" : ""}`, text: source });
        if (producer) {
          name.element.onclick = () => this._select({ kind: "node", node: producer });
        }
        let readers;
        if (version.readers.length) {
          const names = version.readers.slice(0, 3).map((r) => r.label).join(", ");
          readers = `read by ${names}${version.readers.length > 3 ? ` +${version.readers.length - 3}` : ""}`;
        } else if (version.dropped) {
          readers = "discarded by the pass (storeOp: \"discard\")";
        } else {
          readers = resource.sink ? resource.sink : "not read again in this capture";
        }
        new Span(item, { class: "render-graph-list-value", text: readers });
      }
    }
  }

  _nodeTooltip(node) {
    const parts = [node.label];
    if (node.durationMs !== null) {
      parts.push(`${node.durationMs.toFixed(3)} ms`);
    }
    if (node.draws) {
      parts.push(_plural(node.draws, node.kind === "compute" ? "dispatch" : "draw", node.kind === "compute" ? "dispatches" : "draws"));
    }
    parts.push(`${node.reads.length} read, ${node.writes.length} written`);
    if (node.unread) {
      parts.push("nothing in the capture reads its output");
    }
    return parts.join("\n");
  }

  _resourceTooltip(row) {
    const parts = [row.label, row.detail].filter(Boolean);
    parts.push(`${row.uses.length} accesses across passes ${row.first}-${row.last}`);
    if (row.externalInput) {
      parts.push("read before anything in the capture wrote it");
    }
    if (row.hostInput) {
      parts.push("uploaded by the host in this capture");
    }
    if (row.sink) {
      parts.push(row.sink);
    }
    return parts.join("\n");
  }
}

/** One entry per neighbor pass: several resources between two passes are one row. */
function _dedupeEdges(entries) {
  const byNode = new Map();
  for (const e of entries) {
    const existing = byNode.get(e.node);
    if (existing) {
      existing.count++;
    } else {
      byNode.set(e.node, { ...e, count: 1 });
    }
  }
  return [...byNode.values()].map((e) => ({ node: e.node, label: e.count > 1 ? `${e.label} +${e.count - 1}` : e.label, usage: e.usage }));
}

function _plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

function _ellipsis(text, max) {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}
