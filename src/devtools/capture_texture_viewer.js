// A capture-side texture viewer for render-pass attachments, with pixel
// picking and pixel history. Unlike "Inspect" (which jumps to the Inspector
// panel and the live object), this stays inside the capture tab and works
// against the captured frame: click a pixel to trace every draw in the frame
// that touched it — and jump into the fragment debugger for any of them.
//
// The display controls (zoom, exposure, channels, auto-range) and the pixel
// tooltip follow the Inspector panel's TextureViewer conventions.

import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Checkbox } from "./widget/checkbox.js";
import { Select } from "./widget/select.js";
import { NumberInput } from "./widget/number_input.js";
import { runPixelHistoryGen } from "./pixel_history.js";
import { buildPixelHistoryPasses } from "./pixel_history_builder.js";
import { computeOverdraw } from "./overdraw.js";
import { replayOverdraw, queryPixelCoverage } from "./capture_replay.js";

function _formatChannel(v) {
    if (v === null || v === undefined) {
        return "?";
    }
    if (Number.isInteger(v)) {
        return `${v}`;
    }
    return v.toFixed(4).replace(/\.?0+$/, "") || "0";
}

function _formatValue(value, isDepth) {
    if (!value) {
        return "unknown";
    }
    if (isDepth) {
        return `depth ${_formatChannel(value[0])}`;
    }
    return `[${value.map(_formatChannel).join(", ")}]`;
}

// A css color approximating the value for the entry swatch (unknown → grey).
function _swatchColor(value) {
    if (!value || value.some((c) => c === null || c === undefined)) {
        return null;
    }
    const c = value.map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255));
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.min(Math.max(value[3], 0), 1)})`;
}

// Heatmap ramp for the overdraw overlay: index = count - 1, last entry is
// "N or more". Green (1×) through red to white (8×+).
const _overdrawRamp = [
    [40, 130, 50],
    [110, 160, 30],
    [185, 180, 20],
    [230, 150, 20],
    [235, 90, 25],
    [220, 40, 50],
    [230, 40, 140],
    [255, 255, 255],
];

const _fragmentStatusInfo = {
    "written": { label: "wrote", color: "#6fcf6f" },
    "depth-unknown": { label: "wrote (depth test result unknown — prior depth not captured)", color: "#d9c22b" },
    "stencil-unknown": { label: "wrote (stencil test result unknown — prior stencil not captured)", color: "#d9c22b" },
    "depth-failed": { label: "failed the depth test", color: "#e07a5a" },
    "stencil-failed": { label: "failed the stencil test", color: "#e07a5a" },
    "backface-culled": { label: "backface culled", color: "#e07a5a" },
    "frontface-culled": { label: "frontface culled", color: "#e07a5a" },
    "scissor-failed": { label: "outside the scissor rect", color: "#e07a5a" },
    "viewport-clipped": { label: "outside the viewport", color: "#e07a5a" },
    "depth-clipped": { label: "depth clipped (ndc z outside [0, 1])", color: "#e07a5a" },
    "discarded": { label: "discarded by the fragment shader", color: "#e07a5a" },
    "degenerate": { label: "degenerate (zero-area) primitive", color: "#999" },
    "not-written": { label: "did not write this attachment", color: "#999" },
};

export class CaptureTextureViewer extends Div {
    /**
     * @param {Object} options
     *   texture           - the attachment's Texture object
     *   passIndex         - render pass index within the frame
     *   attachmentLabel   - e.g. "Color Attachment 0" | "Depth-Stencil"
     *   isDepth           - the target is the pass's depth-stencil attachment
     *   gpuTexture        - the GPU copy to display (defaults to
     *                       texture.gpuTexture)
     *   valuesAreCurrent  - texture.imageData reflects this pass's end state
     *   capturePanel, database, commands
     *   onShowCommand(command)  - jump the capture tab to a command
     *   onDebugFragment(drawCommand, seed) - open the fragment debugger
     */
    constructor(options) {
        super(null, { style: "overflow: hidden; display: flex; flex-direction: column; height: 100%;", ...options.widgetOptions });
        this._element.classList.add("capture-texture-viewer");

        this.texture = options.texture;
        this.passIndex = options.passIndex;
        this.attachmentLabel = options.attachmentLabel;
        this.isDepth = !!options.isDepth;
        this.gpuTexture = options.gpuTexture ?? options.texture.gpuTexture;
        this.valuesAreCurrent = !!options.valuesAreCurrent;
        this.capturePanel = options.capturePanel;
        this.database = options.database;
        this.commands = options.commands;
        this.onShowCommand = options.onShowCommand;
        this.onDebugFragment = options.onDebugFragment;

        this._pixelX = -1;
        this._pixelY = -1;

        const texture = this.texture;

        // Per-viewer display settings (kept separate from texture.display so
        // this tab doesn't fight the Inspector's texture viewer).
        this._display = {
            exposure: 1,
            channels: 0,
            autoRange: false,
            minRange: 0,
            maxRange: 1,
            zoom: 100,
        };
        const layerRanges = texture.layerRanges;
        if (layerRanges && 0 in layerRanges) {
            this._display.minRange = layerRanges[0]?.min ?? 0;
            this._display.maxRange = layerRanges[0]?.max ?? 1;
        }

        // --- Toolbar. -------------------------------------------------------
        const labelStyle = "margin-left: 10px; margin-right: 3px; font-size: 9pt; color: #bbb;";
        const toolbar = new Div(this, { style: "flex: 0 0 auto; display: flex; align-items: center; padding: 5px; color: #bbb;" });
        new Span(toolbar, {
            text: `Render Pass ${this.passIndex} — ${this.attachmentLabel} — Texture:${texture.idName} ${texture.format} ${texture.resolutionString}`,
        });

        new Checkbox(toolbar, { text: "Auto Range", checked: this._display.autoRange, style: "margin-left: 10px; font-size: 9pt; color: #bbb;", onChange: (checked) => {
            this._display.autoRange = checked;
            this._renderTexture();
        } });

        new Span(toolbar, { text: "Exposure", style: labelStyle });
        new NumberInput(toolbar, { value: this._display.exposure, step: 0.01, onChange: (value) => {
            this._display.exposure = value;
            this._renderTexture(true);
        }, style: "width: 100px; display: inline-block;" });

        const channels = ["RGB", "Red", "Green", "Blue", "Alpha", "Luminance"];
        new Select(toolbar, {
            options: channels,
            index: 0,
            style: "color: #fff; margin-left: 10px; font-size: 10pt; width: 100px;",
            onChange: (value) => {
                this._display.channels = channels.indexOf(value);
                this._renderTexture(true);
            }
        });

        new Span(toolbar, { text: "Zoom", tooltip: "Zoom level of the texture, CTRL + mouse-wheel", style: labelStyle });
        this._zoomControl = new NumberInput(toolbar, { tooltip: "Zoom level of the texture, CTRL + mouse-wheel", value: this._display.zoom, step: 1, min: 0, onChange: (value) => {
            this._display.zoom = value;
            this._applyZoom();
        }, style: "width: 100px; display: inline-block;" });

        new Checkbox(toolbar, { text: "Overdraw", checked: false, tooltip: "Heatmap of how many fragments the frame rasterized at each pixel", style: "margin-left: 10px; font-size: 9pt; color: #bbb;", onChange: (checked) => {
            this._setOverdraw(checked);
        } });

        this._pixelLabel = new Span(toolbar, { style: "margin-left: 10px; color: #ddd;" });

        // --- Overdraw status + legend (shown while the overlay is on). -------
        this._overdrawBar = new Div(this, { style: "flex: 0 0 auto; display: none; align-items: center; gap: 4px; padding: 0px 5px 5px 5px; color: #bbb; font-size: 9pt;" });
        this._overdrawStatus = new Span(this._overdrawBar, { style: "margin-right: 8px;" });
        this._overdrawLegend = new Span(this._overdrawBar, { style: "display: none;" });
        for (let i = 0; i < _overdrawRamp.length; ++i) {
            const c = _overdrawRamp[i];
            new Span(this._overdrawLegend, { style: `display: inline-block; width: 12px; height: 12px; margin-left: 6px; vertical-align: middle; border: 1px solid #555; background-color: rgb(${c[0]}, ${c[1]}, ${c[2]});` });
            new Span(this._overdrawLegend, { text: i === _overdrawRamp.length - 1 ? `${i + 1}+` : `${i + 1}`, style: "margin-left: 2px; vertical-align: middle;" });
        }
        this._overdrawNotesPane = new Div(this, { style: "flex: 0 0 auto; display: none; padding: 0px 5px 5px 5px; color: #999; font-size: 9pt; font-style: italic; white-space: normal;" });

        if (!this.valuesAreCurrent) {
            new Div(this, {
                style: "flex: 0 0 auto; padding: 0px 5px 5px 5px; color: #999; font-style: italic;",
                text: "A later pass in the frame also writes this texture; the image and pixel values show the texture's latest captured state.",
            });
        }

        // --- Content: image on the left, history on the right. ---------------
        const content = new Div(this, { style: "flex: 1 1 auto; display: flex; flex-direction: row; min-height: 0;" });

        const imagePane = new Div(content, { style: "flex: 1 1 60%; overflow: auto; background-color: #222; min-width: 0;" });
        this._imageHolder = new Div(imagePane, { style: "position: relative; display: inline-block; line-height: 0; margin: 10px;" });

        this._canvas = this._buildImageCanvas();
        if (this._canvas) {
            this._imageHolder.element.appendChild(this._canvas);
            this._canvas.style.cssText = "display: block; box-shadow: 5px 5px 5px rgba(0,0,0,0.5); image-rendering: -moz-crisp-edges; image-rendering: -webkit-crisp-edges; image-rendering: pixelated; cursor: crosshair;";

            this._marker = document.createElement("div");
            this._marker.style.cssText = "position: absolute; border: 1px solid #ff4040; outline: 1px solid #fff; pointer-events: none; display: none;";
            this._imageHolder.element.appendChild(this._marker);

            this._setupCanvasEvents();
            this._renderTexture();
        } else {
            new Div(this._imageHolder, { text: "The texture image is not available. Capture the frame again to load it.", style: "color: #999; padding: 20px; line-height: normal;" });
        }

        this._historyPane = new Div(content, { style: "flex: 1 1 40%; overflow: auto; background-color: #333; color: #bbb; padding: 5px 10px; min-width: 0;" });
        new Div(this._historyPane, { class: "race-hint", text: "Click a pixel in the image to trace every draw that touched it." });

        // Built lazily on the first pixel pick and reused for every pick: the
        // pass/draw records are pixel-independent (only the per-pixel shader
        // replay depends on the picked pixel).
        this._builtPasses = null;
        this._historyRunId = 0;

        // Overdraw overlay state: the count buffer is pixel-independent, so it
        // is computed once per viewer and reused when the overlay is retoggled.
        this._overdrawEnabled = false;
        this._overdrawResult = null;
        this._overdrawRunId = 0;
        this._overdrawFallbackReason = null;
        this._overlayCanvas = null;
    }

    onDestroy() {
        this._overdrawRunId++; // cancel any in-flight overdraw compute
        const tooltip = this.capturePanel?._tooltip;
        if (tooltip) {
            tooltip.style.display = "none";
        }
    }

    // Create the canvas the attachment is blitted into. The blit itself
    // happens in _renderTexture, and re-runs when display settings change.
    _buildImageCanvas() {
        const texture = this.texture;
        if (!texture.width || !texture.height || !this.gpuTexture || !this.capturePanel?.window?.device) {
            return null;
        }
        const canvas = document.createElement("canvas");
        canvas.width = texture.width;
        canvas.height = texture.height;
        return canvas;
    }

    // Blit the texture's captured GPU copy into the canvas with the current
    // display settings — the same path the Inspector's texture viewer uses.
    // (The render-pass thumbnail canvases can't be copied with drawImage: a
    // WebGPU canvas's drawing buffer is cleared once presented.)
    _renderTexture(skipMinMax) {
        if (!this._canvas) {
            return;
        }
        const texture = this.texture;
        try {
            const context = this._canvas.getContext("webgpu");
            const dstFormat = navigator.gpu.getPreferredCanvasFormat();
            const device = this.capturePanel.window.device;
            context.configure({ device, format: dstFormat });
            const canvasTexture = context.getCurrentTexture();

            const srcView = this.gpuTexture.object.createView({
                dimension: "2d",
                baseArrayLayer: 0,
                arrayLayerCount: 1,
            });

            this.capturePanel.textureUtils.blitTexture(
                srcView, texture.format, 1, canvasTexture.createView(), dstFormat,
                this._display, "2d", 0,
                skipMinMax ? null : (minRange, maxRange) => {
                    this._display.minRange = minRange;
                    this._display.maxRange = maxRange;
                });
        } catch (e) {
            console.error("Failed to blit texture preview:", e);
        }
        this._applyZoom();
    }

    get _zoom() {
        return Math.max(this._display.zoom, 1) / 100;
    }

    _applyZoom() {
        const zoom = this._zoom;
        if (this._canvas) {
            this._canvas.style.width = `${this.texture.width * zoom}px`;
            this._canvas.style.height = `${this.texture.height * zoom}px`;
        }
        if (this._overlayCanvas) {
            this._overlayCanvas.style.width = `${this.texture.width * zoom}px`;
            this._overlayCanvas.style.height = `${this.texture.height * zoom}px`;
        }
        this._updateMarker();
    }

    _updateMarker() {
        if (!this._marker) {
            return;
        }
        if (this._pixelX < 0 || this._pixelY < 0) {
            this._marker.style.display = "none";
            return;
        }
        const zoom = this._zoom;
        const size = Math.max(zoom, 4);
        this._marker.style.display = "block";
        this._marker.style.left = `${this._pixelX * zoom - (size - zoom) / 2}px`;
        this._marker.style.top = `${this._pixelY * zoom - (size - zoom) / 2}px`;
        this._marker.style.width = `${size}px`;
        this._marker.style.height = `${size}px`;
    }

    _eventPixel(e) {
        const rect = this._canvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left) / rect.width * this.texture.width);
        const y = Math.floor((e.clientY - rect.top) / rect.height * this.texture.height);
        if (x < 0 || y < 0 || x >= this.texture.width || y >= this.texture.height) {
            return null;
        }
        return { x, y };
    }

    _getPixel(x, y) {
        if (!this.texture.isMipLevelLoaded(0)) {
            return null;
        }
        return this.texture.getPixel(x, y, 0, 0);
    }

    // Multi-line pixel string for the tooltip, matching the Inspector viewer.
    _getPixelString(pixel) {
        if (!pixel) {
            return "<unknown pixel value>";
        }
        let str = "";
        for (const c of ["r", "g", "b", "a"]) {
            if (pixel[c] !== undefined && pixel[c] !== null) {
                str += `${c.toUpperCase()}: ${pixel[c]}\n`;
            }
        }
        return str;
    }

    // The pixel value from texture.imageData — the texture's latest captured
    // state, which is what the displayed image shows.
    _pixelValueString(x, y) {
        const pixel = this._getPixel(x, y);
        if (!pixel) {
            return null;
        }
        const parts = [];
        for (const c of ["r", "g", "b", "a"]) {
            if (pixel[c] !== undefined && pixel[c] !== null) {
                parts.push(`${c.toUpperCase()}: ${_formatChannel(pixel[c])}`);
            }
        }
        return parts.join(" ");
    }

    // The floating pixel tooltip is shared with the panel (same element and
    // .inspector-tooltip styling as the Inspector's texture viewer).
    _tooltip() {
        if (!this.capturePanel._tooltip) {
            const tooltip = document.createElement("pre");
            document.body.appendChild(tooltip);
            tooltip.classList.add("inspector-tooltip");
            tooltip.style.display = "none";
            this.capturePanel._tooltip = tooltip;
        }
        return this.capturePanel._tooltip;
    }

    _setupCanvasEvents() {
        const canvas = this._canvas;

        canvas.addEventListener("mouseenter", () => {
            this._tooltip().style.display = "block";
        });

        canvas.addEventListener("mouseleave", () => {
            this._tooltip().style.display = "none";
        });

        canvas.addEventListener("mousemove", (e) => {
            const tooltip = this._tooltip();
            const p = this._eventPixel(e);
            if (!p) {
                tooltip.style.display = "none";
                return;
            }
            tooltip.style.display = "block";

            // Position the (fixed) tooltip relative to the viewport, flipping
            // it to the left/above the cursor when it would extend past the
            // right/bottom edge so it stays fully on screen.
            const margin = 10;
            const tw = tooltip.offsetWidth || 160;
            const th = tooltip.offsetHeight || 110;
            let left = e.clientX + margin;
            let top = e.clientY + margin;
            if (left + tw > window.innerWidth) {
                left = Math.max(0, e.clientX - tw - margin);
            }
            if (top + th > window.innerHeight) {
                top = Math.max(0, e.clientY - th - margin);
            }
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
            tooltip.innerHTML = `X:${p.x} Y:${p.y}\n${this._getPixelString(this._getPixel(p.x, p.y))}`;
            const count = this._overdrawCountAt(p.x, p.y);
            if (count !== null) {
                tooltip.innerHTML += `Overdraw: ${count}\n`;
            }
        });

        canvas.addEventListener("click", (e) => this._onCanvasClick(e));

        canvas.addEventListener("wheel", (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                let zoom = this._display.zoom;
                if (e.deltaY < 0) {
                    zoom += 10;
                } else {
                    zoom -= 10;
                }
                zoom = Math.max(0, zoom);
                this._zoomControl.setValue(zoom);
                this._display.zoom = zoom;
                this._applyZoom();
            }
        });
    }

    _onCanvasClick(e) {
        const p = this._eventPixel(e);
        if (!p) {
            return;
        }
        if (p.x === this._pixelX && p.y === this._pixelY) {
            return;
        }
        this._pixelX = p.x;
        this._pixelY = p.y;
        const value = this._pixelValueString(p.x, p.y);
        this._pixelLabel.text = value ? `(${p.x}, ${p.y})  ${value}` : `(${p.x}, ${p.y})`;
        this._updateMarker();
        this._runHistory();
    }

    // ------------------------------------------------------------------------
    // Pixel history
    // ------------------------------------------------------------------------

    _runHistory() {
        if (this._pixelX < 0 || this._pixelY < 0) {
            return;
        }
        const pane = this._historyPane;
        pane.removeAllChildren();
        const statusText = `Computing pixel history for (${this._pixelX}, ${this._pixelY})…`;
        const status = new Div(pane, { class: "race-status", text: statusText });

        // The replay runs vertex and fragment shaders on the CPU interpreter
        // and can take minutes on heavy frames, so drive it in ~12ms slices to
        // keep the panel responsive, with pass/draw progress in the status.
        // If the user picks another pixel before this run finishes, the newer
        // run supersedes it.
        const runId = ++this._historyRunId;
        setTimeout(async () => {
            if (runId !== this._historyRunId) {
                return;
            }

            // GPU pre-filter: replay the frame's draws with a 1x1 scissor and
            // occlusion queries to learn which ones rasterize fragments at
            // this pixel, so the CPU interpreter only simulates those. Falls
            // back to simulating everything if replay isn't possible.
            let drawFilter = null;
            const device = this.capturePanel?.window?.device;
            if (device) {
                status.text = `${statusText} locating draws with GPU replay…`;
                try {
                    const coverage = await queryPixelCoverage({
                        device,
                        database: this.database,
                        commands: this.commands,
                        x: this._pixelX,
                        y: this._pixelY,
                        getTextureFromAttachment: (attachment) => this.capturePanel._getTextureFromAttachment(attachment),
                    });
                    drawFilter = (draw) => coverage.covered.has(draw.command) || coverage.unknown.has(draw.command);
                } catch (e) {
                    console.warn("GPU pixel-coverage query failed; simulating every draw:", e);
                }
                if (runId !== this._historyRunId) {
                    return;
                }
            }

            let iter;
            try {
                if (!this._builtPasses) {
                    this._builtPasses = buildPixelHistoryPasses(
                        this.database,
                        this.commands,
                        (attachment) => this.capturePanel._getTextureFromAttachment(attachment));
                }
                iter = runPixelHistoryGen(this._builtPasses.passes, this._pixelX, this._pixelY, this.texture.id, drawFilter);
            } catch (e) {
                console.error(e);
                pane.removeAllChildren();
                new Div(pane, { class: "race-error", text: `Pixel history failed: ${e.message ?? e}` });
                return;
            }
            let progress = null;
            const step = () => {
                if (runId !== this._historyRunId) {
                    return;
                }
                let result;
                try {
                    const start = performance.now();
                    let r = iter.next();
                    while (!r.done && performance.now() - start < 12) {
                        if (r.value) {
                            progress = { ...progress, ...r.value };
                        }
                        r = iter.next();
                    }
                    if (!r.done) {
                        if (progress) {
                            let text = `${statusText} pass ${progress.passIndex + 1}/${progress.passCount}`;
                            if (progress.drawCount) {
                                text += `, draw ${(progress.draw ?? 0) + 1}/${progress.drawCount}`;
                            }
                            status.text = text;
                        }
                        setTimeout(step, 0);
                        return;
                    }
                    result = r.value;
                } catch (e) {
                    console.error(e);
                    pane.removeAllChildren();
                    new Div(pane, { class: "race-error", text: `Pixel history failed: ${e.message ?? e}` });
                    return;
                }
                pane.removeAllChildren();
                this._showHistory(result, this._builtPasses?.notes ?? []);
            };
            step();
        }, 10);
    }

    _showHistory(result, notes) {
        const pane = this._historyPane;

        // Culled fragments are expected in bulk on any closed mesh (every
        // pixel sees the object's backfaces), so they are excluded from the
        // history — unless nothing else touched the pixel, where "it was
        // culled" is exactly the answer to "why didn't my object render"
        // (wrong winding), so they stay, collapsed.
        const isCulled = (e) => e.type === "fragment" && (e.status === "backface-culled" || e.status === "frontface-culled");
        const culledCount = result.entries.filter(isCulled).length;
        const fragmentCount = result.entries.filter((e) => e.type === "fragment").length;
        const keepCulled = culledCount > 0 && culledCount === fragmentCount;
        const entries = keepCulled ? result.entries : result.entries.filter((e) => !isCulled(e));

        let summary = `Pixel (${this._pixelX}, ${this._pixelY}) — ${this.attachmentLabel} — ${keepCulled ? fragmentCount : fragmentCount - culledCount} fragment event(s)`;
        if (!keepCulled && culledCount) {
            summary += ` (${culledCount} culled not shown)`;
        }
        new Div(pane, { class: "race-summary", text: summary });

        for (const note of notes) {
            new Div(pane, { class: "race-hint", text: note });
        }

        if (!entries.length) {
            new Div(pane, { class: "race-hint", text: "No render pass in this frame writes this texture." });
            return;
        }

        // Consecutive same-status culled (all-culled fallback only) or
        // degenerate fragments from the same draw collapse into one summary
        // row.
        const collapsible = new Set(["backface-culled", "frontface-culled", "degenerate"]);
        for (let i = 0; i < entries.length;) {
            const entry = entries[i];
            let j = i;
            if (entry.type === "fragment" && collapsible.has(entry.status)) {
                while (j + 1 < entries.length &&
                    entries[j + 1].type === "fragment" &&
                    entries[j + 1].status === entry.status &&
                    entries[j + 1].draw === entry.draw) {
                    j++;
                }
            }
            if (j > i) {
                this._showCollapsedFragments(pane, entries.slice(i, j + 1));
            } else {
                this._showHistoryEntry(pane, entry);
            }
            i = j + 1;
        }

        // Cross-check the simulated final value against the captured texture
        // data when this pass is the texture's latest state in the capture.
        const captured = this.valuesAreCurrent ? this._pixelValueString(this._pixelX, this._pixelY) : null;
        if (captured && result.finalValue && !result.finalValue.some((c) => c === null)) {
            new Div(pane, {
                class: "race-hint",
                text: `Captured value at end of pass: ${captured}. The simulation is a CPU approximation; small differences are expected.`,
            });
        }
    }

    // ------------------------------------------------------------------------
    // Overdraw overlay
    // ------------------------------------------------------------------------

    _overdrawCountAt(x, y) {
        const result = this._overdrawEnabled ? this._overdrawResult : null;
        if (!result || x >= result.width || y >= result.height) {
            return null;
        }
        return result.counts[y * result.width + x];
    }

    _setOverdraw(enabled) {
        this._overdrawEnabled = enabled;
        if (!this._canvas) {
            return;
        }
        if (!enabled) {
            this._overdrawRunId++; // cancel an in-flight compute
            if (this._overlayCanvas) {
                this._overlayCanvas.style.display = "none";
            }
            this._overdrawBar.element.style.display = "none";
            this._overdrawNotesPane.element.style.display = "none";
            return;
        }
        this._overdrawBar.element.style.display = "flex";
        if (this._overdrawResult) {
            this._showOverdraw();
        } else {
            this._computeOverdraw();
        }
    }

    // Compute the overdraw counts: GPU replay first (fast, and covers indirect
    // draws), falling back to the chunked CPU engine when replay isn't
    // possible.
    _computeOverdraw() {
        const runId = ++this._overdrawRunId;
        this._overdrawStatus.text = "Computing overdraw (GPU replay)…";
        this._overdrawLegend.element.style.display = "none";
        this._overdrawFallbackReason = null;

        setTimeout(async () => {
            if (runId !== this._overdrawRunId) {
                return;
            }
            try {
                const result = await replayOverdraw({
                    device: this.capturePanel?.window?.device,
                    database: this.database,
                    commands: this.commands,
                    targetTexture: this.texture,
                    getTextureFromAttachment: (attachment) => this.capturePanel._getTextureFromAttachment(attachment),
                });
                if (runId !== this._overdrawRunId) {
                    return;
                }
                this._overdrawResult = result;
                this._showOverdraw();
                return;
            } catch (e) {
                console.warn("GPU overdraw replay failed; falling back to the CPU engine:", e);
                if (runId !== this._overdrawRunId) {
                    return;
                }
                this._overdrawFallbackReason = `GPU replay failed (${e.message ?? e}); computed with the CPU engine instead.`;
            }
            this._computeOverdrawCPU(runId);
        }, 10);
    }

    // The CPU fallback, run in time slices so the panel stays responsive: the
    // engine yields after every instance of every draw, and each slice runs
    // ~12ms of it before yielding back to the event loop.
    _computeOverdrawCPU(runId) {
        this._overdrawStatus.text = "Computing overdraw (CPU)…";
        let iter;
        try {
            if (!this._builtPasses) {
                this._builtPasses = buildPixelHistoryPasses(
                    this.database,
                    this.commands,
                    (attachment) => this.capturePanel._getTextureFromAttachment(attachment));
            }
            iter = computeOverdraw(this._builtPasses.passes, this.texture.id);
        } catch (e) {
            console.error(e);
            this._overdrawStatus.text = `Overdraw failed: ${e.message ?? e}`;
            return;
        }
        const step = () => {
            if (runId !== this._overdrawRunId) {
                return;
            }
            try {
                const start = performance.now();
                let r = iter.next();
                while (!r.done && performance.now() - start < 12) {
                    r = iter.next();
                }
                if (!r.done) {
                    this._overdrawStatus.text = `Computing overdraw (CPU)… ${Math.round(r.value.progress * 100)}%`;
                    setTimeout(step, 0);
                    return;
                }
                this._overdrawResult = r.value;
                this._showOverdraw();
            } catch (e) {
                console.error(e);
                this._overdrawStatus.text = `Overdraw failed: ${e.message ?? e}`;
            }
        };
        step();
    }

    _showOverdraw() {
        const result = this._overdrawResult;

        let status = `Max overdraw: ${result.maxCount}× (${result.gpu ? "GPU replay" : "CPU"}).`;
        if (result.skippedDraws) {
            status += ` ${result.skippedDraws} draw(s) not counted.`;
        }
        this._overdrawStatus.text = status;
        this._overdrawLegend.element.style.display = "inline";
        const notes = [
            "Counts are rasterized fragments (after culling, viewport, scissor and depth clip); depth/stencil tests and fragment-shader discard do not reduce them.",
            ...(this._overdrawFallbackReason ? [this._overdrawFallbackReason] : []),
            ...result.notes,
        ];
        this._overdrawBar.element.title = notes.join("\n");

        // Surface the actionable notes (skips, truncation, fallbacks) inline;
        // the full list also goes to the console for debugging.
        const inline = notes.slice(1);
        const pane = this._overdrawNotesPane;
        pane.removeAllChildren();
        if (inline.length) {
            const shown = inline.slice(0, 4);
            for (const note of shown) {
                new Div(pane, { text: note });
            }
            if (inline.length > shown.length) {
                new Div(pane, { text: `(+${inline.length - shown.length} more — see the DevTools console)` });
            }
            pane.element.style.display = "block";
            console.info("[webgpu-inspector] overdraw notes:", inline);
        } else {
            pane.element.style.display = "none";
        }

        if (!this._overlayCanvas) {
            const overlay = document.createElement("canvas");
            overlay.width = this.texture.width;
            overlay.height = this.texture.height;
            overlay.style.cssText = "position: absolute; left: 0; top: 0; pointer-events: none; image-rendering: pixelated; z-index: 1;";
            this._imageHolder.element.appendChild(overlay);
            this._marker.style.zIndex = "2";
            this._overlayCanvas = overlay;
        }

        const overlay = this._overlayCanvas;
        const ctx = overlay.getContext("2d");
        const image = ctx.createImageData(overlay.width, overlay.height);
        const data = image.data;
        const w = Math.min(overlay.width, result.width);
        const h = Math.min(overlay.height, result.height);
        for (let y = 0; y < h; ++y) {
            for (let x = 0; x < w; ++x) {
                const count = result.counts[y * result.width + x];
                if (!count) {
                    continue;
                }
                const c = _overdrawRamp[Math.min(count, _overdrawRamp.length) - 1];
                const i = (y * overlay.width + x) * 4;
                data[i] = c[0];
                data[i + 1] = c[1];
                data[i + 2] = c[2];
                data[i + 3] = 217; // ~0.85 alpha, so the image shows through
            }
        }
        ctx.putImageData(image, 0, 0);
        overlay.style.display = "block";
        this._applyZoom();
    }

    // One row summarizing a run of same-status culled/degenerate fragments
    // from the same draw.
    _showCollapsedFragments(pane, group) {
        const entry = group[0];
        const draw = entry.draw;
        const info = _fragmentStatusInfo[entry.status] ?? { label: entry.status, color: "#999" };

        let text = `${this._passTitle(entry.pass, false)} ${draw.command.method}`;
        if (draw.shaderLabel) {
            text += ` (shader “${draw.shaderLabel}”)`;
        }
        const shown = group.slice(0, 4).map((e) => e.primitive);
        text += ` — ${group.length} primitives (${shown.join(", ")}${group.length > shown.length ? ", …" : ""}): ${info.label}`;

        const row = this._entryRow(pane, info.color, text);
        const buttonBar = document.createElement("div");
        buttonBar.style.cssText = "margin-left: auto; display: flex; gap: 4px; flex: 0 0 auto;";
        row.appendChild(buttonBar);
        const goBtn = document.createElement("button");
        goBtn.textContent = "Go to";
        goBtn.title = "Show this draw in the command list";
        goBtn.style.cssText = "background-color: #555; color: #ddd; border: none; border-radius: 3px; cursor: pointer; padding: 2px 6px;";
        goBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.onShowCommand?.(draw.command);
        });
        buttonBar.appendChild(goBtn);
    }

    // "Pass 2 “Scene / Opaque / main pass”" — the pass index plus its label,
    // prefixed with the debug groups it's nested in when withGroups is set.
    _passTitle(pass, withGroups) {
        let title = `Pass ${pass.passIndex}`;
        const parts = withGroups ? [...(pass.groups ?? []), pass.label] : [pass.label];
        const label = parts.filter(Boolean).join(" / ");
        if (label) {
            title += ` “${label}”`;
        }
        return title;
    }

    _showHistoryEntry(pane, entry) {
        if (entry.type === "clear" || entry.type === "load") {
            // The pass-begin row carries the full context: debug groups + label.
            const row = this._entryRow(pane, "#4a6d8c", `${this._passTitle(entry.pass, true)}: ${entry.type === "clear" ? "cleared to" : "loaded"} ${entry.value ? _formatValue(entry.value, entry.isDepth) : "(value unknown — not captured)"}`, entry.value);
            row.title = "Go to the render pass";
            row.style.cursor = "pointer";
            row.addEventListener("click", () => this.onShowCommand?.(entry.pass.command));
            return;
        }

        const passLabel = this._passTitle(entry.pass, false);

        if (entry.type === "end") {
            this._entryRow(pane, "#4a6d8c", `${passLabel}: ended with ${_formatValue(entry.value, entry.isDepth)}`, entry.value);
            return;
        }

        if (entry.type === "draw-error") {
            const cmd = entry.draw?.command ?? entry.draw;
            const method = cmd?.method ?? "draw";
            this._entryRow(pane, "#d99a2b", `${passLabel} ${method}: ${entry.message}`);
            return;
        }

        // Fragment entry.
        const draw = entry.draw;
        const method = draw.command.method;
        const info = _fragmentStatusInfo[entry.status] ?? { label: entry.status, color: "#999" };

        let text = `${passLabel} ${method}`;
        if (draw.shaderLabel) {
            text += ` (shader “${draw.shaderLabel}”)`;
        }
        text += ` — primitive ${entry.primitive}`;
        if (draw.instanceCount > 1) {
            text += `, instance ${entry.instance}`;
        }
        text += `: ${info.label}`;
        const wrote = entry.value !== undefined;
        if (wrote) {
            text += ` ${_formatValue(entry.value, this.isDepth && !entry.shaderOutput)}`;
            if (entry.blended && entry.shaderOutput) {
                text += ` (shader output ${_formatValue(entry.shaderOutput, false)}, blended)`;
            }
        } else if (entry.status === "depth-failed" && entry.fragDepth !== undefined && entry.depthBefore !== undefined) {
            text += ` (fragment depth ${_formatChannel(entry.fragDepth)} vs ${_formatChannel(entry.depthBefore)})`;
        }
        if (entry.fsError) {
            text += ` [fragment shader error: ${entry.fsError}]`;
        }

        const row = this._entryRow(pane, info.color, text, wrote ? entry.value : (entry.shaderOutput ?? null));

        const buttonBar = document.createElement("div");
        buttonBar.style.cssText = "margin-left: auto; display: flex; gap: 4px; flex: 0 0 auto;";
        row.appendChild(buttonBar);

        const goBtn = document.createElement("button");
        goBtn.textContent = "Go to";
        goBtn.title = "Show this draw in the command list";
        goBtn.style.cssText = "background-color: #555; color: #ddd; border: none; border-radius: 3px; cursor: pointer; padding: 2px 6px;";
        goBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.onShowCommand?.(draw.command);
        });
        buttonBar.appendChild(goBtn);

        if (draw.runFragment && this.onDebugFragment) {
            const dbgBtn = document.createElement("button");
            dbgBtn.textContent = "Debug";
            dbgBtn.title = "Debug this fragment in the shader debugger";
            dbgBtn.style.cssText = "background-color: rgb(90, 40, 40); color: #ddd; border: none; border-radius: 3px; cursor: pointer; padding: 2px 6px;";
            dbgBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.onDebugFragment(draw.command, {
                    pixelX: this._pixelX,
                    pixelY: this._pixelY,
                    instanceIndex: entry.instance,
                    primitiveIndex: entry.primitive,
                });
            });
            buttonBar.appendChild(dbgBtn);
        }
    }

    // A history row: colored left border, optional value swatch, message.
    _entryRow(pane, color, text, value) {
        const row = document.createElement("div");
        row.style.cssText = `display: flex; flex-direction: row; align-items: center; gap: 6px; padding: 4px 6px; margin-bottom: 3px; border-left: 3px solid ${color}; background-color: #2b2b2b; white-space: normal;`;

        const swatchColor = value ? _swatchColor(value) : null;
        if (swatchColor) {
            const swatch = document.createElement("span");
            swatch.style.cssText = `display: inline-block; width: 14px; height: 14px; flex: 0 0 auto; border: 1px solid #555; background-color: ${swatchColor};`;
            row.appendChild(swatch);
        }

        const message = document.createElement("span");
        message.textContent = text;
        message.style.cssText = "color: #ddd; white-space: normal;";
        row.appendChild(message);

        pane.element.appendChild(row);
        return row;
    }
}
