import { Widget } from "./widget.js";
import { Div } from "./div.js";

const renderColor = "#4a8db8";
const computeColor = "#a87cd0";
const minSegmentPx = 2;
const stripHeightPx = 28;

/**
 * Horizontal GPU pass timeline for a captured frame. Each segment is one render
 * or compute pass, sized proportional to its GPU duration. Clicking a segment
 * expands and scrolls the matching pass into view in the command tree.
 */
export class TimelineWidget extends Widget {
  constructor(parent, options) {
    super("div", parent, options);
    this._element.style.cssText = [
      "width: 100%",
      "height: 0",
      "overflow: hidden",
      "white-space: nowrap",
      "background: #1e1e1e",
      "border-bottom: 1px solid #333",
      "box-sizing: border-box",
      "position: relative",
      "transition: height 120ms ease-out"
    ].join(";");
    this._strip = new Div(this, {
      style: `position: relative; height: ${stripHeightPx}px; width: 100%;`
    });
    this._scale = new Div(this, {
      style: "font-size: 10px; color: #888; padding: 2px 6px; height: 14px; line-height: 14px;"
    });
    this._segments = [];
  }

  clear() {
    this._strip.element.innerHTML = "";
    this._scale.element.textContent = "";
    this._segments.length = 0;
    this._element.style.height = "0";
  }

  /**
   * Show a single-line placeholder message. Used when "Profile Passes" was
   * enabled for the capture but timestamp data hasn't arrived yet (or the
   * adapter didn't grant the feature, so it never will).
   */
  showPlaceholder(text) {
    this._strip.element.innerHTML = "";
    this._segments.length = 0;
    this._strip.element.style.cssText = [
      "position: relative",
      "height: " + stripHeightPx + "px",
      "width: 100%",
      "display: flex",
      "align-items: center",
      "justify-content: center",
      "color: #888",
      "font-size: 11px",
      "font-style: italic"
    ].join(";");
    this._strip.element.textContent = text;
    this._scale.element.textContent = "";
    this._element.style.height = stripHeightPx + "px";
  }

  /**
   * @param {{ commands: Object[], firstTime: number }} data
   */
  setData(data) {
    this.clear();
    // Reset the strip layout in case showPlaceholder() left it in flex/centered mode.
    this._strip.element.style.cssText = `position: relative; height: ${stripHeightPx}px; width: 100%;`;

    const commands = data?.commands;
    if (!commands || commands.length === 0) {
      return;
    }

    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const cmd of commands) {
      if (cmd.startTime < minStart) {
        minStart = cmd.startTime;
      }
      if (cmd.endTime > maxEnd) {
        maxEnd = cmd.endTime;
      }
    }
    const span = maxEnd - minStart;
    if (!(span > 0)) {
      return;
    }

    let totalGpuMs = 0;
    for (const cmd of commands) {
      totalGpuMs += cmd.duration || 0;

      const isRender = cmd.method === "beginRenderPass";
      const color = isRender ? renderColor : computeColor;
      const leftPct = ((cmd.startTime - minStart) / span) * 100;
      // CSS `min-width: ${minSegmentPx}px` below keeps tiny passes visible; the
      // width percentage just needs to be proportional and non-negative.
      const widthPct = Math.max((cmd.duration / span) * 100, 0);

      const seg = document.createElement("div");
      seg.style.cssText = [
        "position: absolute",
        `top: 2px`,
        `bottom: 2px`,
        `left: ${leftPct}%`,
        `width: ${widthPct}%`,
        `min-width: ${minSegmentPx}px`,
        `background: ${color}`,
        "border-radius: 2px",
        "cursor: pointer",
        "overflow: hidden",
        "color: #fff",
        "font-size: 10px",
        "line-height: " + (stripHeightPx - 4) + "px",
        "padding: 0 4px",
        "box-sizing: border-box",
        "white-space: nowrap",
        "text-overflow: ellipsis"
      ].join(";");

      const label = cmd.args?.[0]?.label;
      const passLabel = label ? `"${label}"` : (isRender ? `Render ${cmd._passIndex ?? ""}` : `Compute ${cmd._passIndex ?? ""}`);
      seg.textContent = `${passLabel} ${cmd.duration.toFixed(2)}ms`;
      seg.title = `${isRender ? "Render Pass" : "Compute Pass"}${label ? ` "${label}"` : ""}\nDuration: ${cmd.duration.toFixed(3)}ms\nStart: ${(cmd.startTime - minStart).toFixed(3)}ms`;

      seg.addEventListener("mouseenter", () => {
        seg.style.filter = "brightness(1.25)";
      });
      seg.addEventListener("mouseleave", () => {
        seg.style.filter = "";
      });
      seg.addEventListener("click", () => {
        this._jumpTo(cmd);
      });

      this._strip.element.appendChild(seg);
      this._segments.push(seg);
    }

    this._scale.element.textContent = `${commands.length} passes - ${totalGpuMs.toFixed(2)}ms GPU - ${span.toFixed(2)}ms span`;
    this._element.style.height = (stripHeightPx + 14) + "px";
  }

  _jumpTo(command) {
    const headerSpan = command.header;
    if (!headerSpan?.element) {
      return;
    }
    const headerDiv = headerSpan.element.parentElement;
    if (!headerDiv) {
      return;
    }
    // The pass body is the next sibling of the header inside the pass container.
    // If it's collapsed, click the header to expand before scrolling so the user
    // lands on a fully visible pass.
    const block = headerDiv.nextElementSibling;
    if (block && block.classList.contains("collapsed")) {
      headerDiv.click();
    }
    headerDiv.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

TimelineWidget._idPrefix = "TIMELINE";
