// WebGPU Inspector — Iframe Worker, Manual Injection Worker
//
// This is the worker half of the iframe_worker_manual_test.html sample. All of
// the WebGPU work in this sample happens here, in a dedicated worker that runs
// inside an iframe.
//
// The sample drives this worker in one of two mutually exclusive modes:
//
//   * Local capture  (onInit)         — calls webgpuInspector.initialize() and
//                                       records frames with the local capture
//                                       API, saved as a JSON file.
//   * DevTools panel (onInitDevtools) — does NOT call initialize(); the
//                                       inspector's normal __WebGPUInspector
//                                       messages are relayed up to the page so
//                                       the WebGPU Inspector extension's
//                                       DevTools panel can see this worker.
//
// ---------------------------------------------------------------------------
// MANUAL INJECTION
//
// importScripts() runs synchronously: every line below it executes only after
// webgpu_inspector.js has finished loading. The inspector wraps navigator.gpu /
// GPUDevice / GPUQueue / ... synchronously while it loads, so by the time this
// worker creates its first WebGPU object the wrappers are already in place.
// This is the worker-side equivalent of the
//   <script src="../extensions/chrome/webgpu_inspector.js"></script>
// tag used by manual_injection_capture.html.
//
// The path is relative to THIS worker file:
//   test/iframe_worker_manual_worker.js  ->  extensions/chrome/webgpu_inspector.js
//
// Because the iframe that spawns this worker does NOT load the inspector, the
// worker is created at its real URL (the inspector's Worker proxy, which would
// otherwise wrap the worker in a Blob and break relative paths, is never
// installed). So this relative path resolves the way importScripts() normally
// resolves: against the worker script's own URL.
//
// Loaded this way, the inspector exposes itself as `self.webgpuInspector` in
// the worker's global scope.
// ---------------------------------------------------------------------------
importScripts("../extensions/chrome/webgpu_inspector.js");

function post(message) {
  // Plain worker -> iframe channel. Separate from the inspector's own
  // __WebGPUInspector messaging; the iframe relays both up to the parent.
  self.postMessage(message);
}

function log(message, level) {
  post({ type: "log", message, level });
}

function setState(label, kind) {
  post({ type: "state", label, kind });
}

// Sanity check: webgpu_inspector.js installs `self.webgpuInspector` during its
// IIFE. If it's missing the importScripts() above didn't load (404, wrong
// path, or no WebGPU support in this worker).
if (!self.webgpuInspector) {
  log("ERROR: self.webgpuInspector is not defined. Did webgpu_inspector.js load?", "error");
} else {
  log("webgpu_inspector.js loaded inside the worker (manual injection).");
}

// ---- WebGPU state ----------------------------------------------------------
let device = null;
let context = null;
let pipeline = null;
let vertexBuffer = null;
let uniformBuffer = null;
let bindGroup = null;
let depthView = null;
let presentationFormat = null;

let framesCaptured = 0;
let rafAngle = 0;

self.addEventListener("message", async (ev) => {
  const data = ev.data;
  // The inspector loaded above installs its own "message" listener for the
  // {__WebGPUInspector: ...} envelopes the panel relay delivers. Those have no
  // `type`, so ignore them here and let the inspector handle them.
  if (!data || !data.type) {
    return;
  }
  switch (data.type) {
    case "init":
      await onInit(data.offscreenCanvas);
      break;
    case "init-devtools":
      await onInitDevtools(data.offscreenCanvas);
      break;
    case "capture":
      onCapture(data.count);
      break;
    case "save":
      await onSave();
      break;
  }
});

// ---- 1. initialize() + WebGPU setup ----------------------------------------
async function onInit(canvas) {
  // initialize() turns on the local capture store. It MUST run before the
  // first WebGPU object is created — the inspector does not retroactively
  // replay descriptors for objects that existed earlier. Calling it here,
  // before setupWebGPU(), satisfies that.
  self.webgpuInspector.initialize();
  log("self.webgpuInspector.initialize() called.");
  setState("initialized", "on");

  const ok = await setupWebGPU(canvas);
  if (!ok) {
    setState("error");
    return;
  }

  // Keep the offscreen canvas animating so it isn't blank between captures.
  // Frames drawn by this loop are not recorded — only frames bracketed by
  // beginFrameCapture()/endFrameCapture() in onCapture() are.
  requestAnimationFrame(rafLoop);

  post({ type: "setup-done" });
  log("WebGPU set up inside the worker. Ready to capture.");
}

// ---- DevTools panel mode ---------------------------------------------------
// Alternative to onInit(): set up WebGPU but deliberately do NOT call
// initialize(), so the local capture store stays off. The inspector is still
// loaded (via the importScripts() at the top of this file) and still posts its
// normal __WebGPUInspector messages for every WebGPU call. The iframe and the
// parent page relay those messages on, and the WebGPU Inspector extension's
// content script hands them to the DevTools panel — so the panel sees this
// worker live, without the local capture API being involved at all.
//
// The extension must be installed and its WebGPU Inspector DevTools panel open
// for this mode to show anything.
async function onInitDevtools(canvas) {
  log("DevTools panel mode — webgpuInspector.initialize() is NOT called.");
  log("Open the WebGPU Inspector DevTools panel to see this worker.");
  setState("devtools", "on");

  const ok = await setupWebGPU(canvas);
  if (!ok) {
    setState("error");
    return;
  }
  // Render continuously so the panel has a live stream of frames to inspect.
  requestAnimationFrame(rafLoop);
  log("WebGPU running. Worker activity is being posted for the DevTools panel.");
}

async function setupWebGPU(canvas) {
  if (!navigator.gpu) {
    log("ERROR: WebGPU not supported in this worker.", "error");
    return false;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    log("ERROR: requestAdapter returned null.", "error");
    return false;
  }
  device = await adapter.requestDevice();

  context = canvas.getContext("webgpu");
  presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: presentationFormat });

  const depthTexture = device.createTexture({
    label: "depth",
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  depthView = depthTexture.createView();

  // x, y, r, g, b for three vertices.
  const vertexData = new Float32Array([
     0.0,  0.5, 1.0, 0.2, 0.2,
    -0.5, -0.5, 0.2, 1.0, 0.2,
     0.5, -0.5, 0.2, 0.2, 1.0,
  ]);
  vertexBuffer = device.createBuffer({
    label: "vertices",
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  // Small uniform buffer; the value is rewritten every frame so writeBuffer
  // commands appear in the capture too.
  uniformBuffer = device.createBuffer({
    label: "uniforms",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const shader = device.createShaderModule({
    label: "tri",
    code: `
      struct Uniforms { angle: f32 };
      @group(0) @binding(0) var<uniform> u: Uniforms;
      struct VSOut {
        @builtin(position) pos: vec4<f32>,
        @location(0) color: vec3<f32>,
      };
      @vertex
      fn vs(@location(0) pos: vec2<f32>, @location(1) color: vec3<f32>) -> VSOut {
        let c = cos(u.angle);
        let s = sin(u.angle);
        let rotated = vec2<f32>(c * pos.x - s * pos.y, s * pos.x + c * pos.y);
        var out: VSOut;
        out.pos = vec4<f32>(rotated, 0.0, 1.0);
        out.color = color;
        return out;
      }
      @fragment
      fn fs(in: VSOut) -> @location(0) vec4<f32> {
        return vec4<f32>(in.color, 1.0);
      }`,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
  });
  bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  pipeline = device.createRenderPipeline({
    label: "tri-pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shader, entryPoint: "vs",
      buffers: [{
        arrayStride: 5 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0,     format: "float32x2" },
          { shaderLocation: 1, offset: 2 * 4, format: "float32x3" },
        ],
      }],
    },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format: presentationFormat }] },
    primitive: { topology: "triangle-list" },
    depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus" },
  });

  return true;
}

function renderFrame(angle) {
  device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([angle, 0, 0, 0]));

  const encoder = device.createCommandEncoder({ label: "frame" });
  const colorView = context.getCurrentTexture().createView();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: colorView,
      clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
    depthStencilAttachment: {
      view: depthView,
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

function rafLoop() {
  rafAngle += 0.01;
  renderFrame(rafAngle);
  requestAnimationFrame(rafLoop);
}

// ---- 2. Capture one or more frames -----------------------------------------
// begin/end is called *around* a direct renderFrame() call so the capture
// isn't entangled with the rAF loop. Each begin/end pair appends one frame's
// commands to the same export.
function onCapture(count) {
  if (!device) {
    log("Cannot capture: WebGPU is not initialized yet.", "error");
    return;
  }
  setState("capturing", "cap");
  for (let i = 0; i < count; ++i) {
    self.webgpuInspector.beginFrameCapture();
    renderFrame(rafAngle + i * 0.05);
    self.webgpuInspector.endFrameCapture();
    framesCaptured++;
  }
  post({ type: "frames", count: framesCaptured });
  log(`Captured ${count} frame${count === 1 ? "" : "s"}.`);
  setState("initialized", "on");
}

// ---- 3. Save the capture ---------------------------------------------------
// saveCaptureData() builds the JSON and would normally trigger a browser
// download. A worker has no `document`, so the download step is skipped and
// the method just returns the JSON object. We post it up to the iframe, which
// forwards it to the parent page where the actual download happens.
async function onSave() {
  setState("saving", "cap");
  log("saveCaptureData() — waiting for any in-flight readbacks...");
  try {
    // saveCaptureData() throws if initialize() was never called.
    const data = await self.webgpuInspector.saveCaptureData();
    const frame = data.frame ?? 0;
    log(`Capture built: frame=${frame}, objects=${Object.keys(data.objects).length}, commands=${data.commands.length}.`);
    post({ type: "capture-data", data, filename: "webgpu_iframe_worker_capture.json" });
    framesCaptured = 0;
    post({ type: "frames", count: 0 });
  } catch (e) {
    log("Save failed: " + e.message, "error");
  }
  setState("initialized", "on");
}

// Tell the iframe (and through it the parent) that the inspector is loaded and
// the worker is ready to be initialized.
post({ type: "ready" });
