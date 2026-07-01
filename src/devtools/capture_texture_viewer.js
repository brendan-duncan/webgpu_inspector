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
import { runPixelHistory } from "./pixel_history.js";
import { buildPixelHistoryPasses } from "./pixel_history_builder.js";

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

        this._pixelLabel = new Span(toolbar, { style: "margin-left: 10px; color: #ddd;" });

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
    }

    onDestroy() {
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
        new Div(pane, { class: "race-status", text: `Computing pixel history for (${this._pixelX}, ${this._pixelY})…` });

        // The replay is synchronous and can take a moment (it runs vertex and
        // fragment shaders on the CPU interpreter); defer so the status paints.
        // If the user picks another pixel before this run finishes, the newer
        // run supersedes it.
        const runId = ++this._historyRunId;
        setTimeout(() => {
            if (runId !== this._historyRunId) {
                return;
            }
            let result = null;
            let error = null;
            try {
                if (!this._builtPasses) {
                    this._builtPasses = buildPixelHistoryPasses(
                        this.database,
                        this.commands,
                        (attachment) => this.capturePanel._getTextureFromAttachment(attachment));
                }
                result = runPixelHistory(this._builtPasses.passes, this._pixelX, this._pixelY, this.texture.id);
            } catch (e) {
                console.error(e);
                error = e;
            }
            if (runId !== this._historyRunId) {
                return;
            }
            pane.removeAllChildren();
            if (error !== null) {
                new Div(pane, { class: "race-error", text: `Pixel history failed: ${error.message ?? error}` });
                return;
            }
            this._showHistory(result, this._builtPasses?.notes ?? []);
        }, 10);
    }

    _showHistory(result, notes) {
        const pane = this._historyPane;
        const entries = result.entries;

        new Div(pane, { class: "race-summary", text: `Pixel (${this._pixelX}, ${this._pixelY}) — ${this.attachmentLabel} — ${entries.filter((e) => e.type === "fragment").length} fragment event(s)` });

        for (const note of notes) {
            new Div(pane, { class: "race-hint", text: note });
        }

        if (!entries.length) {
            new Div(pane, { class: "race-hint", text: "No render pass in this frame writes this texture." });
            return;
        }

        for (const entry of entries) {
            this._showHistoryEntry(pane, entry);
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
