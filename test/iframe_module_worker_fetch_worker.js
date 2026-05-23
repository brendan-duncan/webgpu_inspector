// Module worker for the iframe_module_worker_fetch_test bug repro.
//
// First job: reproduce the original bug. A single top-level fetch against
// an ABSOLUTE path on the same origin runs as the very first thing this
// module body does — that is exactly the user-reported failure mode:
//
//   "Worker thread error. Uncaught TypeError: Failed to execute 'fetch' on
//    'WorkerGlobalScope': Failed to parse URL from /src/assets/textures/atlas.png"
//
// Why that error happens without the fix:
//
//   When the inspector's Worker proxy is installed (i.e. worker injection is
//   enabled), every `new Worker(url, { type: "module" })` is replaced by a
//   blob URL whose source looks roughly like this:
//
//       self.__webgpuInspectorInspectWorkers = true;
//       self.__webgpu_src = function () { /* ... installs fetch / URL /
//         WebSocket / Request proxies that rewrite relative URLs against the
//         worker's real base URL ... */ };
//       self.__webgpu_src();
//       import "<real-worker-url>";
//
//   That static `import` is HOISTED — ES module semantics require an
//   imported module to be fully evaluated before any code in the importing
//   module's body runs. So the real worker (this file) ran BEFORE
//   `self.__webgpu_src()` could install the fetch proxy. The native fetch
//   then resolved the absolute path against `self.location` (the `blob:`
//   URL the worker was loaded from), the blob URL has no directory the
//   path can resolve against, and the browser threw the URL parse error.
//
// The fix in src/webgpu_inspector.js changes the static import to
// `await import(...)`. Dynamic imports run at their textual position (no
// hoisting), and top-level `await` keeps the worker module in evaluation
// until the user's module loads, so the fetch proxy is in place before this
// top-level fetch runs.
//
// Second job: drive a WebGPU render loop so the DevTools panel has live
// worker activity to display. This verifies the inspector is not just
// patching fetch — it is observing the worker's WebGPU calls end-to-end.
// Open the WebGPU Inspector panel and the Inspect tab to see the worker's
// adapter/device/buffers/pipeline/textures, and the Capture tab to record
// a frame from the worker.

// Test manual injection of the inspector
//import('../extensions/chrome/webgpu_inspector.js')

// ---------------------------------------------------------------------------
// PART 1 — top-level fetch (the bug repro)
// ---------------------------------------------------------------------------

// `iframe_module_worker_fetch_test.html` is a known file on the test server
// (this whole sample lives under /test). An absolute path is used on purpose:
// that is the URL shape from the user's bug report
// (`/src/assets/textures/atlas.png`). A relative path like "./foo" would
// exercise the same code path but be less obviously broken.
const FETCH_TARGET = "/test/iframe_module_worker_fetch_test.html";

// Diagnostic: is `fetch` the inspector's patched proxy, or the native fetch?
// `Function.prototype.toString()` on a native function returns
// "function fetch() { [native code] }"; on the proxy installed by the
// inspector it returns the proxy's source. This is logged BEFORE the fetch
// call so the answer survives the worker error when the fetch fails.
const fetchSource = String(self.fetch);
const fetchIsPatched = !fetchSource.includes("[native code]");
console.log(
  "[bug-repro worker] self.location.href =",
  self.location.href,
  "\n  fetch patched =",
  fetchIsPatched,
  "\n  fetch source  =",
  fetchSource.substring(0, 240),
);

// Top-level fetch — no message handler installed yet. This is the point at
// which the bug reproduces.
const fetchRes = await fetch(FETCH_TARGET);

self.postMessage({
  __moduleWorkerFetchTest: {
    type: "result",
    fetch: { ok: fetchRes.ok, status: fetchRes.status, target: FETCH_TARGET },
    fetchIsPatched,
    // Reported back so the page can show that `self.location.protocol` is
    // `blob:` — proof that the inspector's Worker proxy actually wrapped
    // this worker, and the test is exercising the real bug surface.
    location: {
      href: self.location.href,
      origin: self.location.origin,
      protocol: self.location.protocol,
      pathname: self.location.pathname,
    },
  },
});

// ---------------------------------------------------------------------------
// PART 2 — WebGPU render loop
// ---------------------------------------------------------------------------
//
// The iframe transfers an OffscreenCanvas in an `init` message. Once that
// arrives, set up WebGPU and start drawing. Every command issued by this
// worker — adapter/device requests, buffer/texture/pipeline creation,
// command encoder, render pass, submit — should appear in the WebGPU
// Inspector DevTools panel for THIS worker.

let device = null;
let context = null;
let pipeline = null;
let vertexBuffer = null;
let uniformBuffer = null;
let bindGroup = null;
let depthView = null;
let presentationFormat = null;

let canvasWidth = 0;
let canvasHeight = 0;

let frameCount = 0;
let frameAngle = 0;

self.addEventListener("message", async (event) => {
  const data = event.data;
  // Ignore the inspector's own message envelope ({__WebGPUInspector: ...})
  // — those are for the inspector's relay, not for this worker's logic.
  if (!data || !data.type) {
    return;
  }
  if (data.type === "init") {
    await setupWebGPU(data.offscreenCanvas);
    requestAnimationFrame(rafLoop);
  }
});

async function setupWebGPU(canvas) {
  if (!navigator.gpu) {
    self.postMessage({
      __moduleWorkerFetchTest: {
        type: "webgpu-error",
        message: "WebGPU not supported in this worker.",
      },
    });
    return;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    self.postMessage({
      __moduleWorkerFetchTest: {
        type: "webgpu-error",
        message: "requestAdapter returned null.",
      },
    });
    return;
  }
  device = await adapter.requestDevice();

  context = canvas.getContext("webgpu");
  presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: presentationFormat });
  canvasWidth = canvas.width;
  canvasHeight = canvas.height;

  const depthTexture = device.createTexture({
    label: "depth",
    size: [canvasWidth, canvasHeight],
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

  // The uniform is rewritten every frame, so writeBuffer commands also
  // show up in any inspector capture.
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

  self.postMessage({
    __moduleWorkerFetchTest: { type: "webgpu-ready" },
  });
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
  frameAngle += 0.01;
  renderFrame(frameAngle);
  frameCount++;
  // Throttle to keep the page UI from being flooded — the panel sees every
  // frame regardless.
  if (frameCount % 30 === 0) {
    self.postMessage({
      __moduleWorkerFetchTest: { type: "frame-count", count: frameCount },
    });
  }
  requestAnimationFrame(rafLoop);
}
