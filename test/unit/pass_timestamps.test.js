// Unit tests for GPU pass timestamp readback across submits and captures, and
// sharing the page's timestamp queries without replacing its timestampWrites.
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

function loadCommands(local, panel, commands) {
    const results = { action: Actions.CaptureFrameResults, frame: 1, count: commands.length, batches: 1 };
    local.processMessage(results);
    panel.captureFrameResults(results);
    const batch = { action: Actions.CaptureFrameCommands, frame: 1, index: 0, count: commands.length };
    local.processMessage({ ...batch, commands: structuredClone(commands) });
    panel.captureFrameCommands({ ...batch, commands: structuredClone(commands) });
}

function sendTimestamps(local, panel, values) {
    const bytes = new Uint8Array(new BigInt64Array(values).buffer);
    // Split every resolve into two chunks, including in the middle of a u64.
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

function passCommand(method) {
    return { method, args: [{}], header: { text: "" } };
}

test("pass timestamps: first pair, several resolves, and a fresh capture", () => {
    const local = new LocalCaptureStore();
    const panel = new CaptureData(null);
    const commands = [
        { method: "createCommandEncoder" }, passCommand("beginRenderPass"),
        { method: "end" }, passCommand("beginComputePass"), { method: "submit" },
        passCommand("beginRenderPass"), { method: "end" }
    ];
    loadCommands(local, panel, commands);
    sendTimestamps(local, panel, [1000000n, 3000000n, 4000000n, 7000000n]);
    sendTimestamps(local, panel, [8000000n, 12000000n]);
    for (const captured of [local._commands, panel.commands]) {
        assert.deepEqual([1, 3, 5].map((i) => captured[i].duration), [2, 3, 4]);
        assert.deepEqual([1, 3, 5].map((i) => captured[i].startTime), [1, 4, 8]);
        assert.deepEqual([1, 3, 5].map((i) => captured[i].endTime), [3, 7, 12]);
    }
    assert.equal(panel.commands[5].header.text, "Render Pass 1 Duration: 4ms");
    assert.equal(panel.timestampData.commands.length, 3);
    assert.equal(panel.gpuFrameTime, 11);

    for (const reset of ["resetCaptures", "reset"]) {
        local[reset]();
        loadCommands(local, panel, [passCommand("beginComputePass")]);
        sendTimestamps(local, panel, [20000000n, 25000000n]);
        assert.equal(local._commands[0].duration, 5);
        assert.equal(panel.commands[0].duration, 5);
        assert.equal(panel.timestampData.commands.length, 1);
        assert.equal(panel.gpuFrameTime, 5);
    }
});

test("pass timestamps: invalid pairs stay untimed and still consume their pass", () => {
    const local = new LocalCaptureStore();
    const panel = new CaptureData(null);
    loadCommands(local, panel, Array.from({ length: 5 }, () => passCommand("beginComputePass")));
    sendTimestamps(local, panel, [0n, 1000000n, 1000000n, -1n, 3000000n, 2000000n]);
    sendTimestamps(local, panel, [4000000n, 4000000n, 5000000n, 7000000n]);
    for (const captured of [local._commands, panel.commands]) {
        assert.deepEqual(captured.map((c) => c.duration), [undefined, undefined, undefined, 0, 2]);
        assert.equal(captured[4].startTime, 5);
    }
    assert.equal(panel.commands[0].header.text, "Compute Pass 0 Duration: n/a");
    assert.equal(panel.commands[4].header.text, "Compute Pass 4 Duration: 2ms");
    assert.equal(panel.timestampData.commands.length, 2);
    assert.equal(panel.timestampData.firstTime, 4);
    assert.equal(panel.gpuFrameTime, 3);
});

// Commands execute at submit, so resolving after a query is reused would read
// the later pass's values. Resolve alignment is checked like the native API.
function makeCapture() {
    const readbacks = [];
    const inspector = Object.assign(Object.create(Object.getPrototypeOf(webgpuInspector)), {
        _captureTimestamps: true, _captureFrameRequest: true, _maxTimestamps: 2000,
        _timestampIndex: 0, _timestampQuerySet: null, _timestampBuffer: null,
        _frameSubmitCount: 0, _captureTextureRequest: new Map(), _captureTempBuffers: [],
        _captureTexturedBuffers: [], _toDestroy: [], _pendingMapCount: 0,
        disableRecording() {}, enableRecording() {}, _wrapObject() {}, _recordCommand() {},
        _sendTimestampBuffer(count, buffer) {
            readbacks.push(Array.from(new BigInt64Array(buffer.bytes.buffer, 0, count)));
            this._pendingMapFinished();
        }
    });
    const device = {
        createQuerySet({ count }) { return { values: Array(count).fill(0n) }; },
        createBuffer({ size, usage }) { return { bytes: new Uint8Array(size), usage }; },
        createCommandEncoder() {
            const commands = [];
            return Object.assign(new GPUCommandEncoder(), {
                __device: device,
                commands,
                resolveQuerySet(querySet, first, count, buffer, offset) {
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
                    assert.ok(src.usage & GPUBufferUsage.COPY_SRC);
                    assert.ok(dst.usage & GPUBufferUsage.COPY_DST);
                    commands.push(() => dst.bytes.set(src.bytes.subarray(srcOffset, srcOffset + size), dstOffset));
                },
                clearBuffer(buffer, offset, size) {
                    assert.ok(buffer.usage & GPUBufferUsage.COPY_DST);
                    commands.push(() => buffer.bytes.fill(0, offset, offset + size));
                },
                finish() { return commands; }
            });
        }
    };
    device.queue = Object.assign(new GPUQueue(), {
        __device: device,
        submit(buffers) { for (const commands of buffers) for (const command of commands) command(); },
        onSubmittedWorkDone() { return Promise.resolve(); }
    });
    return {
        inspector, device, readbacks,
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
        async submit(encoder) {
            const args = [[encoder.finish()]];
            device.queue.submit(args[0]);
            inspector._postMethodCall(device.queue, "submit", args, undefined);
            await device.queue.onSubmittedWorkDone();
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
    assert.equal(capture.pass(encoder, "beginRenderPass", descriptor, 1000000n, 3000000n), descriptor);
    encoder.resolveQuerySet(querySet, 0, 6, pageBuffers[0], 0);
    capture.pass(encoder, "beginComputePass", {}, 4000000n, 7000000n);
    assert.equal(capture.pass(encoder, "beginComputePass", descriptor, 8000000n, 12000000n), descriptor);
    encoder.resolveQuerySet(querySet, 0, 6, pageBuffers[1], 0);
    await capture.submit(encoder);

    const next = device.createCommandEncoder();
    capture.pass(next, "beginRenderPass", { colorAttachments: [] }, 15000000n, 20000000n);
    await capture.submit(next);
    assert.deepEqual(capture.readbacks, [
        [1000000n, 3000000n, 4000000n, 7000000n, 8000000n, 12000000n],
        [15000000n, 20000000n]
    ]);
    assert.deepEqual(pageBuffers.map((b) => Array.from(new BigInt64Array(b.bytes.buffer))), [
        [0n, 3000000n, 0n, 0n, 1000000n, 0n],
        [0n, 12000000n, 0n, 0n, 8000000n, 0n]
    ]);
    const local = new LocalCaptureStore();
    const panel = new CaptureData(null);
    loadCommands(local, panel, [
        passCommand("beginRenderPass"), passCommand("beginComputePass"),
        passCommand("beginComputePass"), passCommand("beginRenderPass")
    ]);
    for (const values of capture.readbacks) sendTimestamps(local, panel, values);
    for (const commands of [local._commands, panel.commands]) {
        assert.deepEqual(commands.map((c) => c.duration), [2, 3, 4, 5]);
    }
});

test("pass timestamps: a page writing only one boundary is preserved and left untimed", async () => {
    const capture = makeCapture();
    const { device } = capture;
    const first = device.createCommandEncoder();
    capture.pass(first, "beginComputePass", {}, 1000000n, 3000000n);
    await capture.submit(first);

    const querySet = device.createQuerySet({ count: 2 });
    const next = device.createCommandEncoder();
    capture.pass(next, "beginComputePass", { timestampWrites: { querySet, endOfPassWriteIndex: 0 } }, 0n, 7000000n);
    capture.pass(next, "beginRenderPass", {
        colorAttachments: [], timestampWrites: { querySet, beginningOfPassWriteIndex: 1 }
    }, 8000000n, 0n);
    await capture.submit(next);
    assert.deepEqual(capture.readbacks[1], [0n, 7000000n, 8000000n, 0n]);
    assert.deepEqual(querySet.values, [7000000n, 8000000n]);
});

test("pass timestamps: saving waits for a submit before its timestamp map starts", async () => {
    const capture = makeCapture();
    const { inspector, device } = capture;
    let finish;
    const submitted = new Promise((resolve) => { finish = resolve; });
    device.queue.onSubmittedWorkDone = () => submitted;
    const encoder = device.createCommandEncoder();
    capture.pass(encoder, "beginComputePass", {}, 1000000n, 3000000n);
    const args = [[encoder.finish()]];
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
    assert.deepEqual(capture.readbacks, [[1000000n, 3000000n]]);
});
