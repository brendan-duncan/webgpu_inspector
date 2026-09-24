/**
 * Timing Capture: every frame's timing, recorded for as long as the user
 * lets it run, with hitch detection and a best guess at each hitch's cause.
 *
 * A single frame capture shows one frame in depth; a hitch is by definition
 * the frame you weren't capturing. This records the cheap per-frame numbers
 * the inspected page already reports (frame interval, the rAF callback's CPU
 * time, the refresh period, dropped frames) plus the GPU objects the page
 * created between frames, which is where most WebGPU hitches come from:
 * pipelines compiled synchronously, shader modules, and buffer and texture
 * allocations.
 *
 * A hitch is a frame more than HITCH_FACTOR times the rolling median frame
 * time and at least HITCH_MIN_OVER_MS over it — both conditions, so a steady
 * 30 fps game isn't a stream of hitches against a 60 Hz display, and tiny
 * jitter on a fast frame isn't either.
 *
 * DOM-free so it can be unit tested; timing_view.js draws it.
 */

export const HITCH_FACTOR = 2;
export const HITCH_MIN_OVER_MS = 4;
// Frames in the rolling median, and how many are needed before detecting.
const MEDIAN_WINDOW = 120;
const MIN_FRAMES = 10;
const MANY_BIND_GROUPS = 32;

function newCreated() {
    return { syncPipelines: 0, asyncPipelines: 0, shaders: 0, buffers: 0, textures: 0, bindGroups: 0, bytes: 0, errors: 0 };
}

/** The p-th percentile (0..1) of an ascending-sorted array. */
export function percentile(sorted, p) {
    if (!sorted.length) {
        return 0;
    }
    const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[at];
}

export function median(values) {
    return percentile([...values].sort((a, b) => a - b), 0.5);
}

export class TimingRecorder {
    constructor() {
        this.frames = [];
        this.startTime = null;
        this._created = newCreated();
        this._window = [];
    }

    /**
     * Note a GPU object the page created; it is attributed to the next frame.
     * @param {string} type - the object's class name ("RenderPipeline", "Buffer", ...)
     * @param {Object} [info] - { pending: created by an async pipeline call, bytes }
     */
    noteObject(type, info = {}) {
        const c = this._created;
        switch (type) {
            case "RenderPipeline":
            case "ComputePipeline":
                if (info.pending) {
                    c.asyncPipelines++;
                } else {
                    c.syncPipelines++;
                }
                break;
            case "ShaderModule":
                c.shaders++;
                break;
            case "Buffer":
                c.buffers++;
                c.bytes += info.bytes ?? 0;
                break;
            case "Texture":
                c.textures++;
                c.bytes += info.bytes ?? 0;
                break;
            case "BindGroup":
                c.bindGroups++;
                break;
        }
    }

    noteValidationError() {
        this._created.errors++;
    }

    /**
     * Record one frame.
     * @param {Object} sample - { time (ms, receipt), deltaTime, cpuTime, refresh, skipped }
     * @returns {Object} the frame record: { index, time, delta, cpu, refresh, skipped,
     *   created, median, hitch, causes }
     */
    addFrame(sample) {
        if (this.startTime === null) {
            this.startTime = sample.time - (sample.deltaTime ?? 0);
        }
        const delta = sample.deltaTime ?? 0;
        const med = this._window.length >= MIN_FRAMES ? median(this._window) : null;
        const hitch = med !== null && delta > med * HITCH_FACTOR && delta - med >= HITCH_MIN_OVER_MS;
        const frame = {
            index: this.frames.length,
            time: sample.time - this.startTime,
            delta,
            cpu: sample.cpuTime ?? -1,
            refresh: sample.refresh ?? 0,
            skipped: sample.skipped ?? 0,
            created: this._created,
            median: med,
            hitch,
            causes: [],
        };
        if (hitch) {
            frame.causes = hitchCauses(frame);
        }
        this.frames.push(frame);
        this._created = newCreated();
        // Hitches stay out of the window so one long stall doesn't raise the
        // bar for the frames right after it.
        if (!hitch) {
            this._window.push(delta);
            if (this._window.length > MEDIAN_WINDOW) {
                this._window.shift();
            }
        }
        return frame;
    }

    /** Hitch events (see hitchEvents). */
    get hitches() {
        return hitchEvents(this.frames);
    }
}

function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} B`;
}

/**
 * What most likely made a hitch frame long, most likely first. Object
 * creations are attributed to the frame they arrived before, which is the
 * frame they happened in or the one right after.
 * @returns {string[]}
 */
export function hitchCauses(frame) {
    const causes = [];
    const c = frame.created;
    if (c.syncPipelines) {
        causes.push(`${plural(c.syncPipelines, "pipeline")} compiled synchronously (createRenderPipeline / createComputePipeline block until the compile is done; the Async versions don't).`);
    }
    if (c.shaders) {
        causes.push(`${plural(c.shaders, "shader module")} created.`);
    }
    if (c.buffers || c.textures) {
        const parts = [];
        if (c.buffers) {
            parts.push(plural(c.buffers, "buffer"));
        }
        if (c.textures) {
            parts.push(plural(c.textures, "texture"));
        }
        causes.push(`${parts.join(" and ")} allocated${c.bytes ? ` (${formatBytes(c.bytes)})` : ""}.`);
    }
    if (c.bindGroups >= MANY_BIND_GROUPS) {
        causes.push(`${plural(c.bindGroups, "bind group")} created.`);
    }
    if (c.errors) {
        causes.push(`${plural(c.errors, "validation error")} raised.`);
    }
    const budget = frame.refresh > 0 ? frame.refresh : (frame.median ?? 0);
    if (frame.cpu >= 0) {
        if (frame.cpu >= budget && frame.cpu >= frame.delta * 0.5) {
            causes.push(`The frame's rAF callback ran ${frame.cpu.toFixed(1)} ms of JavaScript.`);
        } else if (!causes.length) {
            causes.push(`The rAF callback took only ${frame.cpu.toFixed(1)} ms, so the time went elsewhere: garbage collection, other work on the page's thread, or the GPU or compositor holding the frame back.`);
        }
    } else if (!causes.length) {
        causes.push("No cause was recorded for this frame.");
    }
    if (c.asyncPipelines && !c.syncPipelines) {
        causes.push(`${plural(c.asyncPipelines, "pipeline")} created with the Async calls (compiled off the frame).`);
    }
    return causes;
}

/**
 * Hitch frames grouped into events: consecutive hitch frames (a slowdown that
 * lasts several frames) are one event, not a list of identical entries.
 * @returns {Object[]} { first, last, count, worst (the longest frame), causes, captured }
 */
export function hitchEvents(frames, from = 0, to = frames.length) {
    const events = [];
    let current = null;
    for (let i = from; i < to; ++i) {
        const frame = frames[i];
        if (!frame.hitch) {
            current = null;
            continue;
        }
        if (!current) {
            current = { first: frame, last: frame, count: 0, worst: frame, causes: [], captured: false };
            events.push(current);
        }
        current.last = frame;
        current.count++;
        if (frame.delta > current.worst.delta) {
            current.worst = frame;
        }
        for (const cause of frame.causes) {
            if (!current.causes.includes(cause)) {
                current.causes.push(cause);
            }
        }
        current.captured = current.captured || !!frame.captured;
    }
    return events;
}

/**
 * Statistics over frames [from, to).
 * @returns {Object} { count, durationMs, fps, avg, median, p90, p99, max, cpuAvg,
 *   hitches (events), hitchFrames, dropped }
 */
export function summarizeFrames(frames, from = 0, to = frames.length) {
    const range = frames.slice(from, to);
    const deltas = range.map((f) => f.delta).sort((a, b) => a - b);
    const total = deltas.reduce((s, d) => s + d, 0);
    const cpus = range.filter((f) => f.cpu >= 0).map((f) => f.cpu);
    return {
        count: range.length,
        durationMs: total,
        fps: total > 0 ? (range.length * 1000) / total : 0,
        avg: range.length ? total / range.length : 0,
        median: percentile(deltas, 0.5),
        p90: percentile(deltas, 0.9),
        p99: percentile(deltas, 0.99),
        max: deltas.length ? deltas[deltas.length - 1] : 0,
        cpuAvg: cpus.length ? cpus.reduce((s, v) => s + v, 0) / cpus.length : -1,
        hitches: hitchEvents(frames, from, to).length,
        hitchFrames: range.filter((f) => f.hitch).length,
        dropped: range.reduce((s, f) => s + f.skipped, 0),
    };
}
