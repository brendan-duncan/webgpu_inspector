---
name: webgpu-capture-analysis
description: >-
  Interpret WebGPU Inspector frame captures — the GPU object graph, the command
  list, render/compute passes, buffers, textures, shaders, validation errors,
  and common performance problems. Use when analyzing captures produced by the
  webgpu-inspector plugin's MCP tools or by saveCaptureData() / DevTools "Save
  Capture" files (.wgpuc binary, or legacy .json).
---

# WebGPU capture analysis

A WebGPU Inspector capture is a record of one or more rendered frames: the
full GPU object graph plus the ordered list of WebGPU API calls. This skill
explains how to read one and what to flag.

## Capture files

Saved captures are `.wgpuc` binary files: an ASCII header line
(`WGPUCAP <version> <jsonByteLength>\n`), then `<jsonByteLength>` bytes of
metadata JSON (the object described under "Capture shape" below, so the front
of the file is readable text), then raw buffer/texture payload bytes located
by the metadata's `payloadTable`. Don't parse one by hand — pass the path to
`load_capture_file` and use the MCP tools. Legacy captures (single-object
`.json`, or NDJSON with base64 payload lines) load the same way.

## Capture shape

- `objects` — map of numeric id to a record: `{ id, type, label, descriptor,
  stacktrace, ... }`. Types: `Adapter`, `Device`, `Buffer`, `Texture`,
  `TextureView`, `Sampler`, `BindGroup`, `BindGroupLayout`, `PipelineLayout`,
  `RenderPipeline`, `ComputePipeline`, `ShaderModule`, `RenderBundle`.
- `commands` — ordered array of `{ index, method, object, args, result, ... }`.
  `object` is the GPU object the method was called on; `args` are its
  arguments. References to GPU objects appear as `{ "__id": N, "__class": ...,
  "__label": ... }`.
- `validationErrors` — WebGPU validation errors raised during the capture.
- Large buffer/texture payloads live out-of-band (referenced by
  `__payloadId`); the MCP tools strip them, so you see `__base64Omitted`
  markers and byte lengths instead of bytes.

## Workflow

Always start with `get_capture_summary` — it carries object/command counts,
derived stats, and a heuristic `issues` list. Then drill in:

- `get_commands` with a `method` filter, a `passLabel` regex, or an
  `offset`/`limit` window — never fetch the whole list at once for a large capture.
- `get_object` for a pipeline, bind group, or texture descriptor.
- `get_shader` for a ShaderModule's WGSL.
- `get_validation_errors` for correctness problems.

To debug a specific draw (e.g. "this draw read a vertex attribute as 0"):

- `get_draw_state(commandIndex)` resolves the bound pipeline (+ vertex layout),
  bind groups, vertex/index buffers, and draw params for a draw command. Each
  vertex buffer reports a `bufferDataCommandIndex`.
- `decode_vertex_buffer(commandIndex)` — pass a vertex buffer's
  `bufferDataCommandIndex` to decode its first N vertices into per-attribute
  numbers (the layout is taken from the pipeline automatically).
- `diff_draws(cmdA, cmdB)` compares a working vs. a broken draw's resolved state.

For very large frames, capture only what you need: `capture_frames` accepts
`passLabel` / `passType` (capture heavy payloads for matching passes only) and
`maxBufferSize` (per-buffer byte cap; truncated buffers are marked). To inspect a
live buffer without a full capture, use `read_buffer`.

Cite `index` (command) and `id` (object) values in findings so the user can
locate them in the WebGPU Inspector DevTools Capture panel.

## Performance analysis

When the goal is performance — the frame is slow, janky, dropping frames, or the
user asks where the time goes / whether it's CPU- or GPU-bound / about fillrate —
take the GPU-timed path **by default, without being asked to enable it**:

1. Capture with per-pass GPU timing:
   `capture_frames({ profilePasses: true, payloads: "none" })`. `profilePasses`
   injects per-pass GPU timestamp queries so each render/compute pass carries a
   measured `durationMs` (and the frame a total GPU time); `payloads: "none"` keeps
   the capture light — profiling needs the command list and object graph, not the
   buffer/texture bytes. **Treat "analyze the performance of a frame" as implying
   `profilePasses: true`.**
2. Call `analyze_performance` (not just `get_capture_summary`). It returns the frame
   budget and a CPU-/GPU-/vsync-bound verdict, passes ranked by GPU time each
   annotated with render-target size/format/MSAA, blend usage, fragment-shader
   complexity, and a likely bottleneck (fillrate/ROP vs fragment-ALU), plus
   heuristic issues and ranked improvement suggestions.
3. For a live page, `get_frame_stats` samples fps / dropped frames / CPU submit time
   / bound verdict over a short window without a capture — use it to confirm the page
   is actually dropping frames or is CPU-bound before drilling in.

Notes:
- GPU timing needs the adapter's `timestamp-query` feature; the inspector enables it
  automatically when available and it is a no-op otherwise. Without it,
  `analyze_performance` still ranks passes by fill workload and says GPU time is
  unavailable — re-run once the feature is present for real timings.
- The fillrate-vs-fragment-ALU verdict is a static heuristic (render-target bytes ×
  MSAA × area × blend, plus a WGSL fragment-complexity scan). To *confirm* fillrate,
  reduce the render-target resolution and re-measure: GPU time scaling ~linearly with
  pixel count ⇒ per-pixel (fillrate/fragment) bound; flat ⇒ vertex/geometry/CPU bound.

## What to look for

**Correctness**
- Any `validationErrors` — always report these first; they are real bugs.
- A canvas texture used after its frame expired, or destroyed objects still
  referenced (the inspector reports these as validation errors).

**Per-frame cost / hitching**
- `createRenderPipeline` / `createComputePipeline` inside the captured frame —
  pipeline creation is expensive; move it to load time.
- `createShaderModule` inside the frame — same idea.
- Large or numerous `writeBuffer` / `writeTexture` calls every frame — consider
  persistent buffers, mapped writes, or uploading less.

**CPU submission overhead**
- High `setPipeline` / `setBindGroup` / `setVertexBuffer` counts relative to
  draw calls — sort draws by pipeline and bind group to cut state changes.
- Redundant consecutive `setPipeline` / `setBindGroup` (the summary flags
  these) — the bind is a no-op and can be skipped.
- Many small draw calls with the same pipeline — candidates for instancing,
  batching, or render bundles.

**Pass structure**
- Excess `beginRenderPass` calls — each pass has fixed cost; merge where the
  attachments allow.
- `loadOp: "load"` where `"clear"` would do (forces an attachment read), or
  `storeOp: "store"` on attachments whose result is never used.
- Depth/stencil attachment configuration vs. what the draws need.

**Shaders** (via `get_shader`)
- Work in the fragment stage that could move to the vertex stage.
- Dynamically uniform branching, heavy loops, or texture sampling in loops.
- Bind group layout mismatches across entry points.

## Reporting

Give a prioritized list. For each finding: severity (error > warning > info),
a one-line description, why it matters for this capture, and a concrete fix.
Reference command indices and object ids. Distinguish confirmed bugs
(validation errors) from heuristics (a flagged pattern that may be intentional)
— say which is which rather than overstating.
