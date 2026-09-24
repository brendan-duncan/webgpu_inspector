import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { hitchEvents, summarizeFrames } from "./timing_capture.js";

const CHART_HEIGHT = 200;
const COLORS = {
    ok: "#4e9de0",
    slow: "#dcb44a",
    hitch: "#f14c4c",
    cpu: "rgba(255, 255, 255, 0.35)",
    budget: "#8fd18f",
    median: "#bbbbbb",
    selection: "rgba(86, 156, 214, 0.18)",
};

/**
 * The Timing tab: a recorded Timing Capture as a frame-time chart (worst
 * frame per pixel column, so hitches never disappear into an average), the
 * frame statistics for the whole recording or a dragged selection, and the
 * list of hitches with their likely causes.
 *
 * @param {Object} params
 * @param {Object} params.recorder - a TimingRecorder
 * @returns {Div}
 */
export function buildTimingView({ recorder }) {
    return new TimingView(recorder).panel;
}

class TimingView {
    constructor(recorder) {
        this.frames = recorder.frames;
        this.selection = null; // [from, to) frame indices
        this.highlight = -1;

        this.panel = new Div(null, { class: "timing-view" });
        this.stats = new Div(this.panel, { class: "timing-stats" });
        new Div(this.panel, { class: "timing-hint", text: "Drag across the chart to see the statistics of a range; double-click to clear. Bars are the worst frame per pixel column; the white part is the rAF callback's CPU time." });
        this.chartBox = new Div(this.panel, { class: "timing-chart" });
        this.canvas = document.createElement("canvas");
        this.canvas.style.cssText = `width: 100%; height: ${CHART_HEIGHT}px; display: block; cursor: crosshair;`;
        this.chartBox.element.appendChild(this.canvas);
        this.legend = new Div(this.panel, { class: "flame-legend" });
        for (const [color, text] of [[COLORS.ok, "within 1.5× budget"], [COLORS.slow, "slow"], [COLORS.hitch, "hitch"], [COLORS.budget, "refresh budget"], [COLORS.median, "median"]]) {
            const item = new Span(this.legend, { class: "flame-legend-item" });
            new Span(item, { class: "flame-legend-swatch", style: `background: ${color};` });
            new Span(item, { text });
        }
        this.hitchList = new Div(this.panel, { class: "timing-hitches" });

        this._setupEvents();
        this._resizeObserver = new ResizeObserver(() => this.draw());
        this._resizeObserver.observe(this.chartBox.element);
        this.panel.onDestroy = () => this._resizeObserver.disconnect();

        this._renderStats();
        this._renderHitches();
    }

    _renderStats() {
        const frames = this.frames;
        this.stats.removeAllChildren();
        if (!frames.length) {
            new Div(this.stats, { class: "flame-empty", text: "No frames were recorded. Timing Capture records while the Inspect panel is inspecting the page and the page is rendering." });
            return;
        }
        const [from, to] = this.selection ?? [0, frames.length];
        const s = summarizeFrames(frames, from, to);
        const ms = (v) => `${v.toFixed(2)} ms`;
        const title = this.selection
            ? `Frames ${from}–${to - 1} (${(frames[from].time / 1000).toFixed(2)}–${(frames[to - 1].time / 1000).toFixed(2)} s)`
            : `${frames.length.toLocaleString()} frames over ${(s.durationMs / 1000).toFixed(1)} s`;
        new Div(this.stats, { class: "timing-title", text: title });
        const row = new Div(this.stats, { class: "timing-stat-row" });
        const stat = (label, value, cls) => {
            const cell = new Div(row, { class: "timing-stat" });
            new Div(cell, { class: "timing-stat-label", text: label });
            new Div(cell, { class: `timing-stat-value${cls ? ` ${cls}` : ""}`, text: value });
        };
        stat("FPS", s.fps.toFixed(1));
        stat("Median", ms(s.median));
        stat("Average", ms(s.avg));
        stat("90th %", ms(s.p90));
        stat("99th %", ms(s.p99));
        stat("Worst", ms(s.max), s.hitches ? "timing-bad" : "");
        stat("CPU (rAF) avg", s.cpuAvg >= 0 ? ms(s.cpuAvg) : "—");
        stat("Hitches", String(s.hitches), s.hitches ? "timing-bad" : "");
        stat("Dropped frames", String(s.dropped), s.dropped ? "timing-bad" : "");
    }

    _renderHitches() {
        const hitches = hitchEvents(this.frames);
        this.hitchList.removeAllChildren();
        new Div(this.hitchList, { class: "render-graph-heading", text: hitches.length ? `Hitches (${hitches.length})` : "No hitches" });
        if (!hitches.length) {
            new Div(this.hitchList, { class: "timing-hint", text: "No frame took more than twice the median frame time and at least 4 ms longer than it." });
            return;
        }
        for (const event of hitches) {
            const frame = event.worst;
            const row = new Div(this.hitchList, { class: "timing-hitch" });
            const head = new Div(row, { class: "timing-hitch-head" });
            const label = event.count > 1 ? `Frames ${event.first.index}–${event.last.index}` : `Frame ${frame.index}`;
            const link = new Span(head, { class: "perf-line-link", text: label });
            link.tooltip = event.count > 1 ? "Select the frames in the chart" : "Show the frame in the chart";
            link.element.onclick = () => {
                this.highlight = frame.index;
                this.selection = event.count > 1 ? [event.first.index, event.last.index + 1] : null;
                this.draw();
                this._renderStats();
                this.chartBox.element.scrollIntoView({ block: "nearest" });
            };
            new Span(head, { class: "timing-hitch-time", text: `at ${(event.first.time / 1000).toFixed(2)} s` });
            new Span(head, { class: "timing-bad", text: `${frame.delta.toFixed(1)} ms${event.count > 1 ? " worst" : ""}` });
            const dropped = this.frames.slice(event.first.index, event.last.index + 1).reduce((n, f) => n + f.skipped, 0);
            const droppedText = dropped ? `, ${dropped} dropped` : "";
            const detail = event.count > 1
                ? `(${event.count} slow frames in a row against the ${frame.median.toFixed(1)} ms median${droppedText})`
                : `(${(frame.delta - frame.median).toFixed(1)} ms over the ${frame.median.toFixed(1)} ms median${droppedText})`;
            new Span(head, { class: "timing-hitch-time", text: detail });
            if (event.captured) {
                new Span(head, { class: "timing-captured", text: "captured the next frame" });
            }
            for (const cause of event.causes) {
                new Div(row, { class: "timing-cause", text: cause });
            }
        }
    }

    // Frame index under a canvas-relative x (CSS pixels).
    _frameAt(x) {
        const width = this.canvas.clientWidth;
        const n = this.frames.length;
        return Math.max(0, Math.min(n - 1, Math.floor((x / Math.max(1, width)) * n)));
    }

    _setupEvents() {
        let dragStart = null;
        const x = (e) => e.clientX - this.canvas.getBoundingClientRect().left;
        this.canvas.addEventListener("pointerdown", (e) => {
            if (!this.frames.length) {
                return;
            }
            dragStart = this._frameAt(x(e));
            this.canvas.setPointerCapture(e.pointerId);
        });
        this.canvas.addEventListener("pointermove", (e) => {
            if (dragStart === null) {
                const f = this.frames[this._frameAt(x(e))];
                if (f) {
                    this.canvas.title = `Frame ${f.index}: ${f.delta.toFixed(2)} ms${f.cpu >= 0 ? `, CPU ${f.cpu.toFixed(2)} ms` : ""}${f.hitch ? " (hitch)" : ""}`;
                }
                return;
            }
            const end = this._frameAt(x(e));
            if (end !== dragStart) {
                this.selection = [Math.min(dragStart, end), Math.max(dragStart, end) + 1];
                this.draw();
            }
        });
        this.canvas.addEventListener("pointerup", () => {
            if (dragStart !== null) {
                dragStart = null;
                this._renderStats();
            }
        });
        this.canvas.addEventListener("dblclick", () => {
            this.selection = null;
            this.highlight = -1;
            this.draw();
            this._renderStats();
        });
    }

    draw() {
        const frames = this.frames;
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
        const height = Math.floor(CHART_HEIGHT * dpr);
        this.canvas.width = width;
        this.canvas.height = height;
        const ctx = this.canvas.getContext("2d");
        ctx.fillStyle = "#1b1b1d";
        ctx.fillRect(0, 0, width, height);
        if (!frames.length) {
            return;
        }

        // Scale: the worst frame, capped so one enormous stall doesn't flatten
        // everything else (bars past the top are clipped and marked).
        const all = summarizeFrames(frames);
        const refresh = frames.find((f) => f.refresh > 0)?.refresh ?? 0;
        const cap = Math.max(all.p99 * 2, refresh * 3, all.median * 3, 1);
        const top = Math.min(all.max, cap) * 1.1;
        const y = (ms) => height - (Math.min(ms, top) / top) * height;

        const columns = Math.min(width, frames.length);
        const colWidth = width / columns;
        for (let c = 0; c < columns; ++c) {
            const from = Math.floor((c * frames.length) / columns);
            const to = Math.max(from + 1, Math.floor(((c + 1) * frames.length) / columns));
            let worst = frames[from];
            for (let i = from + 1; i < to; ++i) {
                if (frames[i].delta > worst.delta) {
                    worst = frames[i];
                }
            }
            const budget = worst.refresh > 0 ? worst.refresh : all.median;
            ctx.fillStyle = worst.hitch ? COLORS.hitch : worst.delta > budget * 1.5 ? COLORS.slow : COLORS.ok;
            const x0 = c * colWidth;
            const w = Math.max(1, colWidth - (colWidth > 3 ? 1 : 0));
            ctx.fillRect(x0, y(worst.delta), w, height - y(worst.delta));
            if (worst.cpu >= 0) {
                ctx.fillStyle = COLORS.cpu;
                ctx.fillRect(x0, y(worst.cpu), w, height - y(worst.cpu));
            }
            if (worst.delta > top) {
                ctx.fillStyle = "#fff";
                ctx.fillRect(x0, 0, w, 3 * dpr);
            }
        }

        const hline = (ms, color, dash) => {
            ctx.strokeStyle = color;
            ctx.setLineDash(dash);
            ctx.lineWidth = dpr;
            ctx.beginPath();
            ctx.moveTo(0, y(ms));
            ctx.lineTo(width, y(ms));
            ctx.stroke();
            ctx.setLineDash([]);
        };
        if (refresh > 0) {
            hline(refresh, COLORS.budget, [6 * dpr, 4 * dpr]);
        }
        hline(all.median, COLORS.median, [2 * dpr, 3 * dpr]);

        ctx.fillStyle = "#aaa";
        ctx.font = `${10 * dpr}px sans-serif`;
        ctx.fillText(`${top.toFixed(1)} ms`, 4 * dpr, 12 * dpr);

        const xOf = (index) => (index / frames.length) * width;
        if (this.selection) {
            ctx.fillStyle = COLORS.selection;
            ctx.fillRect(xOf(this.selection[0]), 0, xOf(this.selection[1]) - xOf(this.selection[0]), height);
        }
        if (this.highlight >= 0) {
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2 * dpr;
            const hx = xOf(this.highlight + 0.5);
            ctx.beginPath();
            ctx.moveTo(hx, 0);
            ctx.lineTo(hx, height);
            ctx.stroke();
        }
    }
}
