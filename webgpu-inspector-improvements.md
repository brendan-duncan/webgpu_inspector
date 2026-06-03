# WebGPU Inspector — Improvement Plan

> Hand-off doc for an agent working in the **webgpu-inspector** codebase.
> Motivated by a real debugging session: trying to capture a deferred-renderer
> frame (~71 draws + shadow cascades + IBL + TAA) to inspect why one render pass
> read a vertex attribute as 0 from a buffer that provably contained correct data.
> The capture could not be taken at all, which blocked the investigation.

## Background / current architecture (verify against the code)

The agent should first confirm these assumptions by reading the source:

- An **instrumented page** hooks `GPUDevice`/`GPUQueue`/encoder methods and records:
  an object graph (devices, buffers, textures, pipelines, bind groups, shader
  modules…), a per-frame **command list**, and **payloads** (buffer/texture
  bytes, shader source).
- A **bridge** connects pages to consumers (the DevTools panel and the MCP
  server). Captures are serialized (today, apparently into a single JSON string)
  and surfaced via tools: `capture_frames`, `list_captures`,
  `get_capture_summary`, `get_commands`, `get_object`, `get_shader`,
  `get_validation_errors`, plus `saveCaptureData()` / DevTools "Save Capture".

**Primary failure observed:** `capture_frames` on a moderately complex frame threw
`Invalid string length` (V8's ~512 MB max string) and **persisted nothing** —
`list_captures` returned empty afterward. Shrinking textures to 64×64 and setting
`maxBufferSize: 1024` did **not** help, implying vertex/index/storage payloads (or
the command list) are uncapped and the whole capture is built as one string.

---

## P0 — Capture must never fail on size (top priority)

**Problem.** A single oversized string (whole-capture `JSON.stringify`, or
concatenated base64 payloads) throws and aborts the entire capture. Big apps are
simply uninspectable.

**Goal / acceptance.**
- Capturing a 70+ draw frame with shadow/IBL/post passes **succeeds and persists**;
  `list_captures` shows it; `get_commands` / `get_object` / `get_shader` work on it.
- No code path can throw `Invalid string length`; oversized fields degrade to a
  placeholder instead of failing.

**Approach.**
1. **Split structure from payloads.** Serialize the capture *metadata* (object
   descriptors, command list, pass tree, labels, validation errors) separately
   from *payload bytes* (buffer/texture contents, shader source). Metadata is
   small and must always succeed.
2. **Store payloads out-of-band**, keyed by object id — an in-memory
   `Map<id, Uint8Array>` (or files), **never inline base64 in the metadata
   string**. The existing `get_object`/`get_shader`/`get_commands` accessors
   already strip base64 and fetch lazily — lean into that design; just make sure
   the capture persists so they have something to read.
3. **Guard every payload** with a size cap (see P0b) and a hard ceiling: if a
   field would exceed a safe threshold, replace it with
   `{ omitted: true, byteLength, truncatedTo? }`.
4. **Never `JSON.stringify` the whole thing at once** for transport. Return
   metadata only from `capture_frames`/`get_capture_summary`; payloads come from
   the per-object accessors.

**Discovery notes.** Find where the capture object is assembled and stringified
(likely in the bridge/serializer or the MCP `capture_frames` handler). Search for
`JSON.stringify`, `btoa`/base64 encoding, and where buffer/texture `getMappedRange`
/ readback results are stored.

---

## P0b — `maxBufferSize` applies to *all* buffers

**Problem.** `maxBufferSize` appeared to cap uniform/storage payloads but not
vertex/index/geometry buffers, so a mesh-heavy frame still overflowed.

**Goal.** One cap consistently truncates every captured buffer payload regardless
of usage; the truncation is recorded (`byteLength`, `capturedBytes`).

**Approach.** Centralize payload capture through a single helper that takes the
cap; route all buffer reads (vertex/index/storage/uniform/indirect) through it.
Default the cap to a small value (e.g. 64 KB) so captures are light by default.

---

## P1 — Streaming / chunked capture storage

**Problem.** Even split, a large metadata + many payloads can be big; building it
in one allocation is fragile.

**Goal.** Capture writing scales to large frames without giant intermediate
strings, and `saveCaptureData()` / DevTools "Save Capture" produces a file
incrementally.

**Approach.** Use a streaming writer: emit metadata, then payload blobs, as
**NDJSON** (one JSON object per line) or a small **binary container** (header +
object index + concatenated payload blobs with offsets). `load_capture_file`
parses the same format incrementally. Avoids any single huge string.

---

## P1 — Scoped / filtered capture

**Problem.** I needed exactly **one** render pass (deferred geometry). Capturing
the whole frame (shadows, IBL convolution, bloom, TAA, tonemap + all draws) is
what made it huge and noisy.

**Goal.** Capture only the relevant subset.

**Approach.** Add options to `capture_frames` (and the DevTools UI):
- `passLabel` regex — record only render/compute passes whose
  `beginRenderPass`/`beginComputePass` descriptor `label` matches.
- `drawRange` — only commands in `[start, end)`.
- `passType` — `render` | `compute` | `transfer`.
Implement by gating recording at the instrumentation layer when an option is set
(cheaper) or post-filtering the command list + reachable objects before
serialize. Keep object-graph reachability correct so referenced
pipelines/buffers are still included.

---

## P1 — Per-draw "resolved state" + vertex decode (highest debugging value)

**Problem.** The actual bug was *a draw reading a vertex attribute as 0 from a
buffer that contained correct data*. To diagnose that I needed, for one draw: the
resolved pipeline, the vertex-buffer bindings, the vertex layout, and the decoded
attribute values. I had to hand-roll `COPY_SRC` + `copyBufferToBuffer` + `mapAsync`
in the app to read a buffer (and first failed because the app buffer lacked
`COPY_SRC`).

**Goal.** Two new accessors:
1. `get_draw_state(captureId, commandIndex)` → resolved pipeline (id + label),
   each bind group (group index → entries → resource ids), each vertex buffer
   binding (`slot`, `bufferId`, `offset`, `size`), the pipeline's vertex layout
   (per attribute: `shaderLocation`, `format`, `offset`, `arrayStride`, `slot`),
   index buffer, and draw params.
2. `decode_vertex_buffer(captureId, bufferId, layout, firstN, baseVertex?)` →
   the first `firstN` vertices decoded per attribute into numbers, using the
   layout from (1). So an agent can read "attribute @location(2) (uv) =
   (0.0, 0.0)" directly.

**Acceptance.** For a chosen draw, the agent can print the bound buffers + the
decoded first 8 vertices' attributes without touching the app. This alone would
likely have cracked the bug.

---

## P2 — Diff two draws

**Problem.** A *working* draw and a *broken* draw used the same pipeline; the
difference had to be in bound resources/state.

**Goal.** `diff_draws(captureId, cmdA, cmdB)` → structural diff of the two
resolved-state objects (pipeline, bind groups, vertex/index bindings, dynamic
offsets). Built directly on `get_draw_state`.

---

## P2 — Standalone live buffer readback (no full capture)

**Problem.** I wanted "what's in this GPU buffer right now" without a capture.

**Goal.** `read_buffer(pageId, bufferRef, offset, size)` where the inspector, in
the page, allocates its own readback buffer, `copyBufferToBuffer`s, maps, and
returns bytes.

**Constraint / note.** The source buffer needs `COPY_SRC`; the inspector can't add
usage retroactively. Options: (a) document the limitation and only support buffers
already created with `COPY_SRC`; (b) offer an opt-in instrumentation mode that
forces `COPY_SRC` on all buffer creation (expensive — gate it). Same idea is
worth offering for textures (`read_texture` via a render/copy to a readback
texture).

---

## P2 — MCP result-size hygiene

**Problem.** Even when captures work, tool *results* (e.g. summaries embedding all
shader sources) can be large.

**Goal.**
- `get_capture_summary` gains flags to omit heavy fields (shader source, big
  arrays) and defaults to counts + small metadata.
- Every MCP tool enforces a max result size and **truncates with a clear marker**
  (`"...[truncated, N more]"`) rather than throwing.

---

## P3 — Translated / backend shader (stretch)

**Problem.** The bug smelled like a WGSL→backend (Naga/Tint→SPIR-V/HLSL/MSL)
translation or driver vertex-fetch issue; WGSL source alone wasn't enough.

**Goal.** If obtainable from the browser, expose the translated shader via
`get_shader(..., stage, backend)`. Likely browser-internal and may be infeasible
— mark as investigate-only.

---

## Suggested sequencing

1. **P0 + P0b** — make capture never fail and cap all payloads. *Everything else
   depends on captures persisting.*
2. **P1 scoped capture** — orthogonal, big size win, low risk.
3. **P1 per-draw resolved state + vertex decode** — the highest-value debugging
   primitive; depends on the object graph already captured (P0).
4. **P1 streaming storage** — hardening for very large captures / file save.
5. **P2** diff, live readback, MCP hygiene.
6. **P3** translated shader — spike only.

## Test plan

- A **regression scene** that previously overflowed: a frame with ≥64 draws,
  several render passes, and a few MB of vertex data. Assert `capture_frames`
  succeeds, `list_captures` is non-empty, and `get_commands`/`get_object`/
  `get_shader` return.
- A **payload-cap test**: a 100 MB buffer is captured as `{omitted, byteLength}`,
  capture still succeeds.
- A **vertex-decode test**: a known interleaved vertex buffer + layout decodes to
  the expected attribute values (covers offset/stride/format math).
- A **scoped-capture test**: `passLabel` filter yields only matching passes and
  still includes their referenced pipelines/buffers.
