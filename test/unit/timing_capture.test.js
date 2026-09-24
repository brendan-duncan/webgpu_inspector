// Unit tests for Timing Capture (src/devtools/timing_capture.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { TimingRecorder, hitchEvents, percentile, summarizeFrames } from "../../src/devtools/timing_capture.js";

function record(recorder, deltas, extra = {}) {
    let time = 0;
    return deltas.map((deltaTime) => {
        time += deltaTime;
        return recorder.addFrame({ time, deltaTime, cpuTime: 2, refresh: 16.7, skipped: 0, ...extra });
    });
}

test("timing: percentile", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(sorted, 0.5), 5);
    assert.equal(percentile(sorted, 0.9), 9);
    assert.equal(percentile(sorted, 0.99), 10);
    assert.equal(percentile([], 0.5), 0);
});

test("timing: a long frame is a hitch only against a median and by a margin", () => {
    const recorder = new TimingRecorder();
    // Too early to judge: no median yet.
    const early = record(recorder, [100]);
    assert.equal(early[0].hitch, false);

    const frames = record(recorder, [...Array(20).fill(16.7), 40, 16.7, 16.7]);
    const hitch = frames[20];
    assert.equal(hitch.hitch, true);
    assert.ok(Math.abs(hitch.median - 16.7) < 1e-9);
    assert.equal(recorder.hitches.length, 1);

    // A steady slow cadence (30 fps) is not a stream of hitches.
    const slow = new TimingRecorder();
    record(slow, Array(40).fill(33.3));
    assert.equal(slow.hitches.length, 0);

    // Twice the median but under 4 ms over it is jitter, not a hitch.
    const fast = new TimingRecorder();
    const f = record(fast, [...Array(20).fill(2), 5]);
    assert.equal(f[20].hitch, false);
});

test("timing: hitches don't raise the median, and a run of them is one event", () => {
    const recorder = new TimingRecorder();
    const frames = record(recorder, [...Array(20).fill(16.7), 200, 250, 200, 16.7, 90]);
    assert.deepEqual(frames.slice(20, 23).map((f) => f.hitch), [true, true, true]);
    assert.ok(Math.abs(frames[23].median - 16.7) < 1e-9);
    const events = hitchEvents(recorder.frames);
    assert.equal(events.length, 2);
    assert.equal(events[0].count, 3);
    assert.equal(events[0].worst.delta, 250);
    assert.equal(events[1].first.index, 24);
    assert.equal(summarizeFrames(recorder.frames).hitches, 2);
    assert.equal(summarizeFrames(recorder.frames).hitchFrames, 4);
});

test("timing: object creations are attributed to the next frame and explain the hitch", () => {
    const recorder = new TimingRecorder();
    record(recorder, Array(20).fill(16.7));
    recorder.noteObject("RenderPipeline", { pending: false });
    recorder.noteObject("RenderPipeline", { pending: true });
    recorder.noteObject("Buffer", { bytes: 4 * 1024 * 1024 });
    const [hitch] = record(recorder, [80]);
    assert.equal(hitch.created.syncPipelines, 1);
    assert.equal(hitch.created.asyncPipelines, 1);
    assert.match(hitch.causes[0], /1 pipeline compiled synchronously/);
    assert.match(hitch.causes[1], /1 buffer allocated \(4\.0 MB\)/);
    // The creations were consumed by that frame.
    const [next] = record(recorder, [16.7]);
    assert.equal(next.created.syncPipelines, 0);
});

test("timing: without creations, the cause is the CPU callback or time outside it", () => {
    const busy = new TimingRecorder();
    record(busy, Array(20).fill(16.7));
    const [cpuBound] = record(busy, [60], { cpuTime: 50 });
    assert.match(cpuBound.causes[0], /rAF callback ran 50\.0 ms/);

    const idle = new TimingRecorder();
    record(idle, Array(20).fill(16.7));
    const [elsewhere] = record(idle, [60], { cpuTime: 1 });
    assert.match(elsewhere.causes[0], /time went elsewhere/);
});

test("timing: summary statistics over a range", () => {
    const recorder = new TimingRecorder();
    record(recorder, [...Array(20).fill(10), 50], { skipped: 1 });
    const all = summarizeFrames(recorder.frames);
    assert.equal(all.count, 21);
    assert.equal(all.median, 10);
    assert.equal(all.max, 50);
    assert.equal(all.hitches, 1);
    assert.equal(all.dropped, 21);
    assert.ok(Math.abs(all.fps - 21000 / 250) < 1e-9);
    const range = summarizeFrames(recorder.frames, 0, 20);
    assert.equal(range.hitches, 0);
    assert.equal(range.max, 10);
});
