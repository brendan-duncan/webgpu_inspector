// Unit tests for GPU pass timestamp readback: timings are matched to passes by
// captured command id (not by position), survive several submits, out-of-order
// submits and early or stale readbacks, and the page's own timestampWrites are
// shared without being replaced.
//
// Run with: node --test "test/unit/*.test.js"

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { CaptureData } from "../../src/devtools/capture_data.js";
import { LocalCaptureStore } from "../../src/utils/local_capture.js";
import { Actions } from "../../src/utils/actions.js";

const GPU_TYPES = [
    "GPU", "GPUAdapter", "GPUDevice", "GPUBuffer", "GPUTexture", "GPUTextureView", "GPUSampler",
    "GPUBindGroupLayout", "GPUBindGroup", "GPUPipelineLayout", "GPUShaderModule",
    "GPUComputePipeline", "GPURenderPipeline", "GPUCommandBuffer", "GPUCommandEncoder",
    "GPUComputePassEncoder", "GPURenderPassEncoder", "GPURenderBundle", "GPURenderBundleEncoder",
    "GPUQueue", "GPUQuerySet", "GPUCanvasContext"
];

let webgpuInspector = null;

before(async () => {
    // The inspector and GPUObjectWrapper read these globals during import.
    for (const name of GPU_TYPES) {
        globalThis[name] = class {};
    }
    globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 };
    globalThis.GPUMapMode = { READ: 1 };
    globalThis.self = { addEventListener() {}, postMessage() {} };
    globalThis.requestAnimationFrame = () => 0;
    const setInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    try {
        ({ webgpuInspector } = await import("../../src/webgpu_inspector.js"));
    } finally {
        globalThis.setInterval = setInterval;
    }
});

const ms = (n) => BigInt(Math.round(n * 1000000));

function passCommand(method, commandId) {
    return { method, commandId, args: [{}], header: { text: "" } };
}

function otherCommand(method, commandId) {
    return { method, commandId };
}

// Commands are indexed by commandId, as the inspector numbers them.
function frameCommands(methods) {
    return methods.map((method, i) => method.startsWith("begin") ? passCommand(method, i) : otherCommand(method, i));
}

function sendResults(local, panel, count, serial) {
    const results = { action: Actions.CaptureFrameResults, frame: 1, serial, count, batches: 1 };
    local.processMessage(results);
    panel.captureFrameResults(results);
}

function sendCommands(local, panel, commands) {
    const batch = { action: Actions.CaptureFrameCommands, frame: 1, index: 0, count: commands.length };
    local.processMessage({ ...batch, commands: structuredClone(commands) });
    panel.captureFrameCommands({ ...batch, commands: structuredClone(commands) });
}

function loadCommands(local, panel, commands, serial = 1) {
    sendResults(local, panel, commands.length, serial);
    sendCommands(local, panel, commands);
}

function sendBytes(local, panel, bytes) {
    // Split every readback into two chunks, including in the middle of a u64.
    const split = Math.floor(bytes.length / 2) + 1;
    for (const [index, offset] of [0, split].entries()) {
        const chunk = bytes.subarray(offset, index === 0 ? split : bytes.length);
        const message = {
            action: Actions.CaptureBufferData, commandId: -1000, entryIndex: -1000,
            offset, size: bytes.length, index, count: 2
        };
        local.processMessage({ ...message, chunk });
        panel.captureBufferData({ ...message, chunk: Buffer.from(chunk).toString("base64") });
    }
}

// timings: [[commandId, startMs, endMs], ...] for one capture serial.
function sendTimestamps(local, panel, timings, serial = 1) {
    const values = [];
    for (const [commandId, start, end] of timings) {
        values.push(BigInt(serial), BigInt(commandId), typeof start === "bigint" ? start : ms(start),
            typeof end === "bigint" ? end : ms(end));
    }
    sendBytes(local, panel, new Uint8Array(new BigInt64Array(values).buffer));
}

test("pass timestamps: matched by command id across readbacks in any order", () => {
    const local = new LocalCaptureStore();
    const panel = new CaptureData(null);
    const commands = frameCommands([
        "createCommandEncoder", "beginRenderPass", "end", "beginComputePass", "submit",
        "beginRenderPass", "end"
    ]);
    commands[5]._passIndex = 1;
    loadCommands(local, panel, commands);
    // The second submit's readback lands first.
    sendTimestamps(local, panel, [[5, 8, 12]]);
    sendTimestamps(local, panel, [[1, 1, 3], [3, 4, 7]]);
    for (const captured of [local._commands, panel.commands]) {
        assert.deepEqual([1, 3, 5].map((i) => captured[i].duration), [2, 3, 4]);
        assert.deepEqual([1, 3, 5].map((i) => captured[i].startTime), [1, 4, 8]);
        assert.deepEqual([1, 3, 5].map((i) => captured[i].endTime), [3, 7, 12]);
    }
    assert.equal(panel.commands[5].header.text, "Render Pass 1 Duration: 4ms");
    assert.deepEqual(panel.timestampData.commands.map((c) => c.commandId), [1, 3, 5]);
    assert.equal(panel.gpuFrameTime, 11);

    for (const reset of ["resetCaptures", "reset"]) {
        local[reset]();
        loadCommands(local, panel, frameCommands(["beginComputePass"]), 2);
        sendTimestamps(local, panel, [[0, 20, 25]], 2);
        assert.equal(local._commands[0].duration, 5);
        assert.equal(panel.commands[0].duration, 5);
        assert.equal(panel.timestampData.commands.length, 1);
        assert.equal(panel.gpuFrameTime, 5);
    }
});

test("pass timestamps: invalid timings stay untimed without shifting other passes", () => {
    const local = new LocalCaptureStore();
    const panel = new CaptureData(null);
    const commands = frameCommands(Array(5).fill("beginComputePass"));
    commands.forEach((c, i) => { c._passIndex = i; });
    loadCommands(local, panel, commands);
    sendTimestamps(local, panel, [[0, 0n, ms(1)], [1, ms(1), -1n], [2, 3, 2]]);
    // Pass 3 got no slot at all (e.g. the slots ran out); pass 4 is still matched.
    sendTimestamps(local, panel, [[4, 5, 7]]);
    for (const captured of [local._commands, panel.commands]) {
        assert.deepEqual(captured.map((c) => c.duration), [undefined, undefined, undefined, undefined, 2]);
        assert.equal(captured[4].startTime, 5);
    }
    assert.equal(panel.commands[0].header.text, "Compute Pass 0 Duration: n/a");
    assert.equal(panel.commands[4].header.text, "Compute Pass 4 Duration: 2ms");
    assert.equal(panel.timestampData.commands.length, 1);
    assert.equal(panel.timestampData.firstTime, 5);
    assert.equal(panel.gpuFrameTime, 2);
});

test("pass timestamps: a readback arriving before its commands is applied when they land", () => {
    const local = new LocalCaptureStore();
    const panel = new CaptureData(null);
    // Previous capture is current while the new capture's readback arrives.
    loadCommands(local, panel, frameCommands(["beginRenderPass"]), 1);
    sendTimestamps(local, panel, [[0, 1, 2]], 1);
    local.resetCaptures();

    const commands = frameCommands(["beginRenderPass", "end", "beginComputePass"]);
    sendTimestamps(local, panel, [[0, 10, 13], [2, 14, 20]], 2);
    // Not applied to the previous capture's pass 0.
    assert.equal(panel.commands[0].duration, 1);
    sendResults(local, panel, commands.length, 2);
    // A readback between CaptureFrameResults and the commands is held too.
    sendTimestamps(local, panel, [[1, 30, 31]], 2);
    sendCommands(local, panel, commands);
    for (const captured of [local._commands, panel.commands]) {
        assert.deepEqual(captured.map((c) => c.duration), [3, undefined, 6]);
    }
    assert.equal(panel.timestampData.commands.length, 2);
});

test("pass timestamps: a readback from an older capture is dropped", () => {
    const local = new LocalCaptureStore();
    const panel = new CaptureData(null);
    loadCommands(local, panel, frameCommands(["beginRenderPass"]), 1);
    local.resetCaptures();
    loadCommands(local, panel, frameCommands(["beginComputePass"]), 2);
    // Late readback of capture 1, whose command id 0 now names capture 2's pass.
    sendTimestamps(local, panel, [[0, 1, 2]], 1);
    assert.equal(local._commands[0].duration, undefined);
    assert.equal(panel.commands[0].duration, undefined);
    assert.equal(panel.timestampData, null);
    sendTimestamps(local, panel, [[0, 5, 9]], 2);
    assert.equal(local._commands[0].duration, 4);
    assert.equal(panel.commands[0].duration, 4);
});

// A mock device whose command buffers run their recorded commands at submit, so
// resolving after a query is reused reads the later pass's values. Resolve
// alignment and buffer usages are checked like the native API.
function makeCapture() {
    const sent = [];
    const inspector = Object.assign(Object.create(Object.getPrototypeOf(webgpuInspector)), {
        _captureTimestamps: true, _captureFrameRequest: true, _maxTimestamps: 2000,
        _timestampIndex: 0, _timestampOutstanding: 0, _timestampQuerySet: null,
        _timestampBuffer: null, _timestampScratch: null, _timestampDevice: null,
        _commandId: 0, _captureSerial: 1,
        _frameSubmitCount: 0, _captureTextureRequest: new Map(), _captureTempBuffers: [],
        _captureTexturedBuffers: [], _toDestroy: [], _pendingMapCount: 0,
        disableRecording() {}, enableRecording() {}, _wrapObject() {},
        // Number only the passes, so the expected ids are simply the pass order.
        _recordCommand(object, method, result) {
            if (method === "beginRenderPass" || method === "beginComputePass") {
                result.__id = `_${this._commandId++}`;
            }
        },
        _sendBufferData(commandId, entryIndex, data) {
            assert.equal(commandId, -1000);
            sent.push(data.slice());
        }
    });
    function makeDevice() {
        const device = {
            createQuerySet({ count }) { return { values: Array(count).fill(0n) }; },
            createBuffer({ size, usage }) {
                return {
                    bytes: new Uint8Array(size), usage, device,
                    mapAsync() { return Promise.resolve(); },
                    getMappedRange() { return this.bytes.buffer; },
                    destroy() {}
                };
            },
            createCommandEncoder() {
                const commands = [];
                const checkDevice = (...buffers) => {
                    for (const b of buffers) {
                        if (b.device && b.device !== device) {
                            throw new Error("buffer from another device");
                        }
                    }
                };
                return Object.assign(new GPUCommandEncoder(), {
                    __device: device,
                    commands,
                    resolveQuerySet(querySet, first, count, buffer, offset) {
                        checkDevice(buffer);
                        assert.equal(offset % 256, 0);
                        assert.ok(buffer.usage & GPUBufferUsage.QUERY_RESOLVE);
                        commands.push(() => {
                            const view = new DataView(buffer.bytes.buffer);
                            for (let i = 0; i < count; i++) {
                                view.setBigInt64(offset + i * 8, querySet.values[first + i], true);
                            }
                        });
                    },
                    copyBufferToBuffer(src, srcOffset, dst, dstOffset, size) {
                        checkDevice(src, dst);
                        assert.equal(srcOffset % 4, 0);
                        assert.equal(dstOffset % 4, 0);
                        assert.ok(src.usage & GPUBufferUsage.COPY_SRC);
                        assert.ok(dst.usage & GPUBufferUsage.COPY_DST);
                        commands.push(() => dst.bytes.set(src.bytes.subarray(srcOffset, srcOffset + size), dstOffset));
                    },
                    clearBuffer(buffer, offset, size) {
                        checkDevice(buffer);
                        assert.ok(buffer.usage & GPUBufferUsage.COPY_DST);
                        commands.push(() => buffer.bytes.fill(0, offset, offset + size));
                    },
                    finish() { return commands.slice(); }
                });
            }
        };
        device.queue = Object.assign(new GPUQueue(), {
            __device: device,
            submit(buffers) { for (const commands of buffers) for (const command of commands) command(); },
            onSubmittedWorkDone() { return Promise.resolve(); }
        });
        return device;
    }
    const device = makeDevice();
    return {
        inspector, device, sent, makeDevice,
        // Decoded readbacks: [[serial, commandId, start, end], ...] per submit.
        readbacks() {
            return sent.map((bytes) => {
                const values = Array.from(new BigInt64Array(bytes.buffer));
                const quads = [];
                for (let i = 0; i < values.length; i += 4) {
                    quads.push([Number(values[i]), Number(values[i + 1]), values[i + 2], values[i + 3]]);
                }
                return quads;
            });
        },
        pass(encoder, method, descriptor, start, end) {
            const args = descriptor === undefined ? [] : [descriptor];
            inspector._preMethodCall(encoder, method, args);
            const writes = { ...args[0]?.timestampWrites };
            const pass = method === "beginRenderPass" ? new GPURenderPassEncoder() : new GPUComputePassEncoder();
            if (writes.beginningOfPassWriteIndex !== undefined) {
                encoder.commands.push(() => { writes.querySet.values[writes.beginningOfPassWriteIndex] = start; });
            }
            inspector._postMethodCall(encoder, method, args, pass);
            if (writes.endOfPassWriteIndex !== undefined) {
                encoder.commands.push(() => { writes.querySet.values[writes.endOfPassWriteIndex] = end; });
            }
            inspector._postMethodCall(pass, "end", [], undefined);
            return args[0];
        },
        finish(encoder) {
            const commandBuffer = encoder.finish();
            inspector._postMethodCall(encoder, "finish", [], commandBuffer);
            return commandBuffer;
        },
        // `execute: false` models an invalid command buffer, whose commands never run.
        async submit(encoderOrBuffer, { execute = true } = {}) {
            const commandBuffer = Array.isArray(encoderOrBuffer) ? encoderOrBuffer : this.finish(encoderOrBuffer);
            const queue = (encoderOrBuffer.__device ?? device).queue;
            const args = [[commandBuffer]];
            if (execute) {
                queue.submit(args[0]);
            }
            inspector._postMethodCall(queue, "submit", args, undefined);
            await queue.onSubmittedWorkDone();
            await Promise.resolve();
        }
    };
}

test("pass timestamps: page queries and injected queries both survive reuse and several submits", async () => {
    const capture = makeCapture();
    const { device } = capture;
    const querySet = device.createQuerySet({ count: 6 });
    const descriptor = Object.freeze({
        colorAttachments: [],
        timestampWrites: Object.freeze({ querySet, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 1 })
    });
    const pageBuffers = [0, 1].map(() => device.createBuffer({ size: 48, usage: GPUBufferUsage.QUERY_RESOLVE }));
    const encoder = device.createCommandEncoder();
    assert.equal(capture.pass(encoder, "beginRenderPass", descriptor, ms(1), ms(3)), descriptor);
    encoder.resolveQuerySet(querySet, 0, 6, pageBuffers[0], 0);
    capture.pass(encoder, "beginComputePass", {}, ms(4), ms(7));
    assert.equal(capture.pass(encoder, "beginComputePass", descriptor, ms(8), ms(12)), descriptor);
    encoder.resolveQuerySet(querySet, 0, 6, pageBuffers[1], 0);
    await capture.submit(encoder);

    const next = device.createCommandEncoder();
    capture.pass(next, "beginRenderPass", { colorAttachments: [] }, ms(15), ms(20));
    await capture.submit(next);
    assert.deepEqual(capture.readbacks(), [
        [[1, 0, ms(1), ms(3)], [1, 1, ms(4), ms(7)], [1, 2, ms(8), ms(12)]],
        [[1, 3, ms(15), ms(20)]]
    ]);
    // The page's own readback of its queries is unchanged.
    assert.deepEqual(pageBuffers.map((b) => Array.from(new BigInt64Array(b.bytes.buffer))), [
        [0n, ms(3), 0n, 0n, ms(1), 0n],
        [0n, ms(12), 0n, 0n, ms(8), 0n]
    ]);

    const local = new LocalCaptureStore();
    const panel = new CaptureData(null);
    loadCommands(local, panel, frameCommands([
        "beginRenderPass", "beginComputePass", "beginComputePass", "beginRenderPass"
    ]));
    for (const bytes of capture.sent) sendBytes(local, panel, bytes);
    for (const commands of [local._commands, panel.commands]) {
        assert.deepEqual(commands.map((c) => c.duration), [2, 3, 4, 5]);
    }
});

test("pass timestamps: a page writing only one boundary is preserved and left untimed", async () => {
    const capture = makeCapture();
    const { device } = capture;
    const first = device.createCommandEncoder();
    capture.pass(first, "beginComputePass", {}, ms(1), ms(3));
    await capture.submit(first);

    const querySet = device.createQuerySet({ count: 2 });
    const next = device.createCommandEncoder();
    capture.pass(next, "beginComputePass", { timestampWrites: { querySet, endOfPassWriteIndex: 0 } }, 0n, ms(7));
    capture.pass(next, "beginRenderPass", {
        colorAttachments: [], timestampWrites: { querySet, beginningOfPassWriteIndex: 1 }
    }, ms(8), 0n);
    await capture.submit(next);
    assert.deepEqual(capture.readbacks()[1], [[1, 1, 0n, ms(7)], [1, 2, ms(8), 0n]]);
    assert.deepEqual(querySet.values, [ms(7), ms(8)]);
});

test("pass timestamps: an encoder submitted after a later one keeps its own slots", async () => {
    const capture = makeCapture();
    const { device, inspector } = capture;
    const a = device.createCommandEncoder();
    const b = device.createCommandEncoder();
    capture.pass(a, "beginComputePass", {}, ms(1), ms(2));
    capture.pass(b, "beginComputePass", {}, ms(3), ms(5));
    const bufferA = capture.finish(a);
    await capture.submit(b);
    // A's slot is still outstanding, so slots aren't reused yet.
    assert.equal(inspector._timestampIndex, 4);
    const c = device.createCommandEncoder();
    capture.pass(c, "beginComputePass", {}, ms(6), ms(9));
    await capture.submit(c);
    await capture.submit(bufferA);
    assert.equal(inspector._timestampIndex, 0);
    assert.deepEqual(capture.readbacks(), [
        [[1, 1, ms(3), ms(5)]],
        [[1, 2, ms(6), ms(9)]],
        [[1, 0, ms(1), ms(2)]]
    ]);
});

test("pass timestamps: an invalid command buffer reads back untimed, not old data", async () => {
    const capture = makeCapture();
    const { device } = capture;
    const first = device.createCommandEncoder();
    capture.pass(first, "beginComputePass", {}, ms(1), ms(2));
    await capture.submit(first);
    // Reuses slot 0, but the command buffer never executes.
    const invalid = device.createCommandEncoder();
    capture.pass(invalid, "beginComputePass", {}, ms(3), ms(4));
    await capture.submit(invalid, { execute: false });
    assert.deepEqual(capture.readbacks()[1], [[1, 1, 0n, 0n]]);
});

test("pass timestamps: passes on another device are left alone", async () => {
    const capture = makeCapture();
    const { device, makeDevice, inspector } = capture;
    const first = device.createCommandEncoder();
    capture.pass(first, "beginComputePass", {}, ms(1), ms(2));
    await capture.submit(first);

    const other = makeDevice();
    const querySet = other.createQuerySet({ count: 2 });
    const encoder = other.createCommandEncoder();
    const descriptor = { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } };
    capture.pass(encoder, "beginComputePass", descriptor, ms(3), ms(4));
    const plain = {};
    capture.pass(encoder, "beginComputePass", plain, ms(5), ms(6));
    // Nothing injected, and no cross-device resolve into the inspector's buffers.
    assert.equal(plain.timestampWrites, undefined);
    assert.equal(encoder.__timestampPasses, undefined);
    await capture.submit(encoder);
    assert.equal(capture.sent.length, 1);
    assert.equal(inspector._pendingMapCount, 0);
});

test("pass timestamps: saving waits for a submit before its timestamp map starts", async () => {
    const capture = makeCapture();
    const { inspector, device } = capture;
    let finish;
    const submitted = new Promise((resolve) => { finish = resolve; });
    device.queue.onSubmittedWorkDone = () => submitted;
    const encoder = device.createCommandEncoder();
    capture.pass(encoder, "beginComputePass", {}, ms(1), ms(3));
    const args = [[capture.finish(encoder)]];
    device.queue.submit(args[0]);
    inspector._postMethodCall(device.queue, "submit", args, undefined);
    assert.equal(inspector._pendingMapCount, 1);
    let saved = false;
    const waiting = inspector._waitForCapturedReadbacks().then(() => { saved = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(saved, false);
    finish();
    await waiting;
    assert.equal(inspector._pendingMapCount, 0);
    assert.deepEqual(capture.readbacks(), [[[1, 0, ms(1), ms(3)]]]);
});

test("pass timestamps: a failed submit or map releases the pending count", async () => {
    const capture = makeCapture();
    const { inspector, device } = capture;
    const errors = console.error;
    console.error = () => {};
    try {
        device.queue.onSubmittedWorkDone = () => Promise.reject(new Error("device lost"));
        const lost = device.createCommandEncoder();
        capture.pass(lost, "beginComputePass", {}, ms(1), ms(2));
        await capture.submit(lost).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(inspector._pendingMapCount, 0);

        device.queue.onSubmittedWorkDone = () => Promise.resolve();
        const realCreateBuffer = device.createBuffer;
        device.createBuffer = (desc) => {
            const buffer = realCreateBuffer(desc);
            if (desc.usage & GPUBufferUsage.MAP_READ) {
                buffer.mapAsync = () => Promise.reject(new Error("destroyed"));
            }
            return buffer;
        };
        const unmapped = device.createCommandEncoder();
        capture.pass(unmapped, "beginComputePass", {}, ms(3), ms(4));
        await capture.submit(unmapped);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(inspector._pendingMapCount, 0);
    } finally {
        console.error = errors;
    }
});
