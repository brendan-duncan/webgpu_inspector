import { Widget } from "./widget.js";
import { Div } from "./div.js";

// Row geometry. Frames are laid out as absolutely positioned divs, one row per
// depth, which keeps hover/click/tooltips plain DOM. Trees here are hundreds of
// frames, not the millions a sampling profiler produces, so this is fast enough
// and far simpler than a canvas renderer.
const rowHeightPx = 18;
const rowGapPx = 1;
const minFramePx = 2;

// Palette keyed by what dominates a frame's cost, so the graph reads as "why is
// this expensive" and not just "how expensive". Falls back to the neutral ramp
// when the caller doesn't classify frames.
const dimensionColors = {
  alu: "#4a8db8",
  sfu: "#c98a3a",
  texture: "#c0504d",
  memory: "#7b62c9",
};

const kindColors = {
  entry: "#3f7f5f",
  function: "#4a8db8",
  loop: "#a87cd0",
  branch: "#6c7a89",
  switch: "#6c7a89",
  case: "#6c7a89",
  statement: "#4a8db8",
  recursive: "#8a5a5a",
};

const neutralColor = "#4a8db8";

/**
 * A zoomable flame graph over any tree of `{ name, totalCost, children }`.
 *
 * Width is proportional to `totalCost`, depth is nesting. Clicking a frame
 * zooms into it (the frame becomes full width); a breadcrumb above the graph
 * walks back out. The widget is deliberately agnostic about what a "cost" is —
 * pass `formatValue` to render abstract ops, milliseconds, or invocations.
 */
export class FlameGraph extends Widget {
  /**
   * @param {Widget} parent
   * @param {Object} [options]
   * @param {(node:Object)=>string} [options.formatValue] - value text for tooltips
   * @param {(node:Object)=>string} [options.colorOf] - CSS color per frame
   * @param {(node:Object)=>string} [options.tooltipOf] - full tooltip text
   * @param {(node:Object)=>void} [options.onSelect] - fired on click, before zooming
   * @param {boolean} [options.zoomOnClick=true]
   */
  constructor(parent, options = {}) {
    super("div", parent, options);
    this._element.style.cssText = [
      "width: 100%",
      "background: #1e1e1e",
      "overflow: auto",
      "position: relative",
      "box-sizing: border-box",
    ].join(";");

    this._formatValue = options.formatValue ?? ((n) => n.totalCost.toFixed(1));
    this._colorOf = options.colorOf ?? defaultColorOf;
    this._tooltipOf = options.tooltipOf ?? null;
    this._onSelect = options.onSelect ?? null;
    this._zoomOnClick = options.zoomOnClick !== false;

    this._breadcrumb = new Div(this, {
      style: "font-size: 11px; color: #aaa; padding: 3px 6px; min-height: 16px; line-height: 16px; white-space: nowrap; overflow-x: auto;",
    });
    this._canvas = new Div(this, { style: "position: relative; width: 100%;" });

    this._root = null;
    // The zoom stack: [root, ...ancestors, focus]. Index 0 is always the tree's
    // real root so the breadcrumb can always get home.
    this._stack = [];
  }

  /** @param {Object} root - a `{ name, totalCost, selfCost, children }` tree */
  setData(root) {
    this._root = root;
    this._stack = root ? [root] : [];
    this._render();
  }

  clear() {
    this._root = null;
    this._stack = [];
    this._canvas.element.innerHTML = "";
    this._breadcrumb.element.innerHTML = "";
    this._canvas.element.style.height = "0";
  }

  /** Zoom back out to the full tree. */
  resetZoom() {
    if (this._stack.length > 1) {
      this._stack.length = 1;
      this._render();
    }
  }

  get focus() {
    return this._stack[this._stack.length - 1] ?? null;
  }

  _zoomTo(node, ancestors) {
    this._stack = [this._root, ...ancestors.slice(1), node];
    this._render();
  }

  _render() {
    this._canvas.element.innerHTML = "";
    this._breadcrumb.element.innerHTML = "";

    const focus = this.focus;
    if (!focus) {
      this._canvas.element.style.height = "0";
      return;
    }

    this._renderBreadcrumb();

    // The focused frame spans the full width; everything below scales to it.
    // A zero-cost focus would divide by zero, so bail to an empty graph.
    const scale = focus.totalCost > 0 ? 100 / focus.totalCost : 0;
    let maxDepth = 0;

    const emit = (node, depth, offsetCost, ancestors) => {
      if (depth > maxDepth) {
        maxDepth = depth;
      }
      this._emitFrame(node, depth, offsetCost * scale, node.totalCost * scale, ancestors);

      // Children are laid out left-to-right in their own order, each taking a
      // slice of the parent proportional to its total. Self cost shows up as
      // the uncovered remainder on the right of the parent frame.
      let cursor = offsetCost;
      const childAncestors = ancestors.concat([node]);
      for (const child of node.children ?? []) {
        emit(child, depth + 1, cursor, childAncestors);
        cursor += child.totalCost;
      }
    };

    emit(focus, 0, 0, []);

    this._canvas.element.style.height = `${(maxDepth + 1) * (rowHeightPx + rowGapPx)}px`;
  }

  _renderBreadcrumb() {
    if (this._stack.length <= 1) {
      this._breadcrumb.element.textContent = "";
      return;
    }
    this._stack.forEach((node, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.textContent = " › ";
        sep.style.color = "#666";
        this._breadcrumb.element.appendChild(sep);
      }
      const crumb = document.createElement("span");
      crumb.textContent = node.name;
      const isLast = i === this._stack.length - 1;
      crumb.style.cssText = isLast
        ? "color: #ddd;"
        : "color: #6db3f2; cursor: pointer; text-decoration: underline;";
      if (!isLast) {
        crumb.onclick = () => {
          this._stack.length = i + 1;
          this._render();
        };
      }
      this._breadcrumb.element.appendChild(crumb);
    });
  }

  _emitFrame(node, depth, leftPct, widthPct, ancestors) {
    const frame = document.createElement("div");
    frame.style.cssText = [
      "position: absolute",
      `top: ${depth * (rowHeightPx + rowGapPx)}px`,
      `left: ${leftPct}%`,
      `width: ${widthPct}%`,
      `height: ${rowHeightPx}px`,
      `min-width: ${minFramePx}px`,
      `background: ${this._colorOf(node)}`,
      "border-radius: 2px",
      "box-sizing: border-box",
      "overflow: hidden",
      "white-space: nowrap",
      "text-overflow: ellipsis",
      "color: #fff",
      "font-size: 10px",
      `line-height: ${rowHeightPx}px`,
      "padding: 0 4px",
      "cursor: pointer",
      // A hairline between adjacent frames so equal-colored siblings read as
      // separate boxes.
      "border-right: 1px solid #1e1e1e",
    ].join(";");

    // Only label frames wide enough to show something legible; the tooltip
    // carries the detail for the rest.
    if (widthPct > 1.5) {
      frame.textContent = node.name;
    }
    frame.title = this._tooltipOf ? this._tooltipOf(node) : `${node.name}\n${this._formatValue(node)}`;

    frame.addEventListener("mouseenter", () => {
      frame.style.filter = "brightness(1.3)";
    });
    frame.addEventListener("mouseleave", () => {
      frame.style.filter = "";
    });
    frame.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._onSelect) {
        this._onSelect(node);
      }
      if (this._zoomOnClick && (node.children?.length ?? 0) > 0) {
        this._zoomTo(node, ancestors);
      }
    });

    this._canvas.element.appendChild(frame);
  }
}

function defaultColorOf(node) {
  if (node.dimension && dimensionColors[node.dimension]) {
    return dimensionColors[node.dimension];
  }
  if (node.kind && kindColors[node.kind]) {
    return kindColors[node.kind];
  }
  return neutralColor;
}

FlameGraph.dimensionColors = dimensionColors;
FlameGraph.kindColors = kindColors;
FlameGraph._idPrefix = "FLAMEGRAPH";
