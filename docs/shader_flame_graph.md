# Shader Flame Graph

A flame graph of where a shader — or a whole frame — spends its GPU work, broken
down to the WGSL statement.

There are two views:

* **Shader Cost (modeled)** — in the Inspect panel, under a shader module. One
  entry point at a time, showing the cost of a *single invocation*.
* **Shader Flame Graph** — a Capture tab (the button next to *Analyze Shaders*).
  The whole frame: pass → pipeline → shader stage → statement.

## Reading the graph

Width is cost, depth is nesting. The y-axis stacks entry point → called
functions → loops → branches → statements, so a wide frame near the bottom is
something the shader spends real time in, and the frames above it say why.

Click a frame to zoom into it; the breadcrumb above the graph walks back out.
In the per-shader view, clicking a frame also jumps the shader editor to that
line.

Colors say which *kind* of work dominates a frame:

| Color | Dimension | What it counts |
| --- | --- | --- |
| Blue | ALU | Plain arithmetic and logic |
| Orange | SFU | Transcendentals, `sqrt`, division — special-function-unit ops |
| Red | Texture | `textureSample` / `textureLoad` / `textureStore` |
| Purple | Memory | Storage and uniform buffer accesses |

A shader that is mostly red is texture-bound; mostly purple is bandwidth-bound.
That distinction usually matters more than the raw total.

## Where the numbers come from

Three sources feed the graph, and they are not equally trustworthy:

**Measured.** Pass GPU durations come from timestamp queries, available when the
capture was taken with **Profile Passes** enabled. Fragment invocation counts
come from replaying the frame on the GPU (the *Measure fragments* button).
Per-draw GPU times come from replaying each draw with timestamp queries (the
*Measure draw times* button) — see [Per-draw timing](#per-draw-timing).

**Exact.** Vertex and compute invocation counts are read straight out of the
captured draw and dispatch arguments — `draw(vertexCount, instanceCount)`,
`dispatchWorkgroups(x, y, z)` times the entry point's `@workgroup_size`.

**Modeled.** The per-invocation instruction mix comes from a static analysis of
the WGSL AST: an estimated op cost per expression, multiplied by loop trip
counts, summed up the call tree. This is what *distributes* a measured pass
duration across the shaders inside it.

So in the frame view with pass timings available, the root and each pass width
are **real milliseconds**; only the split *within* a pass is modeled. Without
timestamps the graph falls back to modeled op units, which compare to each other
but not to wall-clock time.

## Fragment counts

Fragment shader invocation counts cannot be derived from a capture — only
rasterization knows them. The *Measure fragments* button replays the frame on
the DevTools GPU device with a stub fragment shader that counts coverage, the
same machinery the overdraw view uses.

Those counts are fragments that reach rasterization: after culling, viewport,
scissor and depth-clip, but **before the depth test**. They are therefore an
upper bound on fragment shader invocations, and the gap between the count and
reality is exactly the work early-Z is saving you.

Until you run the measurement, fragment stages appear as zero-width frames
labelled *invocation count unknown*, rather than being filled in with a guess.

## Per-draw timing

**Measure draw times** replays each draw on its own with timestamp queries, so
every draw's width becomes a measured number. Without it, a pass's measured
milliseconds are divided among its draws *by the model*; with it, the model's
only remaining job is splitting each draw's measured time across that draw's
shader stages and statements.

Two encodings, picked automatically:

* **inside-passes** — `writeTimestamp()` between draws in a single pass, keeping
  the pass structure intact. Needs Chrome's
  `chromium-experimental-timestamp-query-inside-passes`.
* **split-passes** — one pass per draw. Portable, and measured to agree with the
  above to **within 1%** on desktop hardware, where an empty pass costs nothing
  measurable. On a tile-based (mobile) GPU each pass forces a tile flush, so
  treat those numbers as relative rather than absolute.

Three caveats, all surfaced in the UI:

* **Draws are timed in isolation.** They don't overlap or share state the way
  they do in a real pass, so the per-draw times **do not sum to the pass's own
  measured duration** — they overstate it. Compare draws against each other, not
  against the pass total. The root frame is labelled *isolated draw time* rather
  than GPU time for exactly this reason.
* **Depth starts cleared.** Each replayed pass gets fresh attachments, so depth
  written by earlier passes is absent and draws that the real frame hides behind
  others will measure more expensive than they are.
* **Timestamps are quantized** (~1µs on the hardware tested, unchanged by
  disabling Dawn's quantization — it appears to be the hardware tick). A draw
  costing a microsecond is indistinguishable from noise in one shot, so cheap
  draws are automatically re-measured with the draw encoded many times and the
  total divided. That recovers draws down to ~100ns, at the cost of extra
  submissions.

## Ablation: measuring individual statements

Per-draw timing says *which draw* is expensive. Ablation says *which line* is,
by measuring the shader with progressively more of its body executed and
differencing: `cost(cut = k+1) − cost(cut = k)` is the cost of statement `k`.

`instrumentForAblation()` in
[shader_ablation.js](../src/devtools/shader_ablation.js) rewrites a shader so
its entry point can be stopped short at run time:

```wgsl
struct WGPUInspectorAblation { cut : u32 }
@group(1) @binding(0) var<uniform> _wgpuInspectorAblation : WGPUInspectorAblation;

@fragment fn fsMain() -> @location(0) vec4f {
  if (_wgpuInspectorAblation.cut == 0u) { return vec4f(); }
  var acc = 0.0;
  if (_wgpuInspectorAblation.cut == 1u) { return vec4f(); }
  acc = acc + shade(...);
  ...
}
```

The cut point is a **uniform**, not a compile-time constant. That detail is the
whole design, and it is worth explaining.

### Why not just compile a truncated shader per cut?

Because the driver deletes the work you are trying to measure. Both variants
were measured on real hardware
([ablation_harness.html](../test/browser/ablation_harness.html)), against a
shader whose true cost is 0.49 ms:

| Approach | Cost curve across cuts | Signal |
| --- | --- | --- |
| Truncate, return a constant | 0.00205, 0.00205, 0.00205, 0.00205, 0.00205 | **100% lost** |
| Truncate, return a sink value | 0.00205, 0.00205, 0.10035, 0.10035, 0.49050 | preserved |
| Uniform guard (this design) | 0.00307, 0.00291, 0.10035, 0.10026, 0.49152 | preserved |

With a constant return, nothing consumes the statements above the cut, so
dead-code elimination removes them and the curve is perfectly flat — it measures
nothing at all. Returning a *sink* that consumes the accumulated value keeps the
work live and does work, but synthesizing that sink means knowing every in-scope
variable and its type at every cut point.

The uniform guard needs no sink, because for a large `cut` the whole body runs
and the compiler cannot prove any statement unreachable. It also compiles once
instead of once per cut. Its early return uses WGSL's zero-value expression
`T()`, which is valid for any constructible type, so only the return type's
*name* has to be recovered.

### Accuracy

On the same harness, against statements with a known 4:1 cost ratio:

| Statement | Measured | Expected |
| --- | --- | --- |
| `acc = acc + work(u.base * 8u)` | 0.0974 ms | 1× |
| `acc = acc + work(u.base * 32u)` | 0.3913 ms | 4× → **ratio 4.02** |
| trivial statements | ±0.0002 ms | ~0 |

Instrumentation overhead measured at **0.2%** of the shader's cost.

### Using it

Select a frame in the frame flame graph and press **Measure statements**.
Clicking a shader-stage frame targets that stage; clicking a *draw* frame
targets its fragment stage, which matters because an unmeasured fragment stage
has zero width and is culled before you can click it.

Results appear below the graph, ranked by cost, with clickable line numbers that
jump to the shader source. In grouped mode the first draw of the group stands in
for the rest, and the header says so.

### Vertex ablation stubs the fragment stage

Cutting a vertex shader short makes it return a degenerate position, which
rasterizes nothing — so with the real fragment shader attached, the *entire*
fragment cost lands on whichever vertex statement finally produces a valid
position. Measured on the test shader, that misattributed 0.4915 ms of fragment
work onto one vertex line.

Vertex ablation therefore swaps in a trivial fragment shader whose outputs match
the attachment formats. The same shader then measures 0.0012 ms, which is the
real vertex cost. This is reported as a note whenever it happens.

A side effect worth knowing: stubbing the fragment stage removes bindings only
the original fragment shader used from an `auto` pipeline layout, so the
replayed bind groups are filtered to the bindings the vertex stage actually
reads — the same thing the overdraw replay does for the same reason.

### Limits

* **Top-level statements only.** A `return` is legal inside a loop or branch,
  but cutting there stops mid-first-iteration, so differencing measures a
  partial iteration rather than a whole statement. Nested cut points need
  different arithmetic than plain differencing. This is the main gap: cost
  inside a hot loop is attributed to the loop's enclosing statement.
* **Negative costs happen.** A statement cheaper than the measurement noise
  floor can difference to below zero. Those are reported as *too small to
  measure* rather than clamped to zero, because clamping would quietly turn
  noise into a confident-looking figure.
* **Needs a spare bind group.** The uniform has to live somewhere; a shader
  already using all four bind groups can't be instrumented, and says so.

## What the model cannot see

The cost model reads source, not machine code. It does not know about:

* **The driver's optimizer.** Dead code, common subexpressions and constant
  folding all still show up as cost.
* **Occupancy and register pressure.** A shader that spills is far slower than
  its instruction count suggests.
* **Divergence.** Costs are per-invocation averages. An `if` is charged as the
  average of its arms (the expected cost of a uniform branch), so a branch that
  diverges across a warp is under-counted.
* **Memory locality.** Every buffer access costs the same whether it hits cache
  or not.

It also has to assume things the source doesn't state:

* **Unbounded loops.** `while`, `loop`, and `for` loops whose bounds depend on
  buffer data are assumed to run 8 times. Every such assumption is listed under
  the graph and marks its frames as estimated.
* **Indexed draws.** `drawIndexed(indexCount, …)` counts `indexCount` vertex
  invocations, which is an upper bound — the GPU reuses post-transform vertices
  for repeated indices.
* **Indirect draws and dispatches.** Their counts live in a GPU buffer and are
  read at execution time, so they have no invocation count and are shown
  unweighted, with a note.

Loop bounds *are* derived exactly when they can be: literal bounds, module-scope
`const` and `override` values, and the usual `i += k` / `i = i + k` increment
forms all resolve to a real trip count.

## Practical use

The graph is best at answering "which shader, and which part of it, is worth
looking at" — not at predicting absolute timings. A reasonable loop:

1. Capture with **Profile Passes** enabled so the graph is in milliseconds.
2. Open **Shader Flame Graph** and find the widest pass.
3. Run **Measure fragments** if a render pass looks suspiciously cheap — an
   unweighted fragment stage is invisible until you do.
4. Run **Measure draw times** to replace the modeled split between draws with
   measurement. Tick **Per draw** first if you want individual draws rather than
   per-pipeline groups.
5. Zoom into the widest shader stage and look at the color: red says cut texture
   work, purple says cut buffer traffic, orange says a transcendental is in a
   loop.
6. Cross-check against **Analyze Shaders**, which flags specific patterns
   (expensive builtins in loops, loop-invariant expressions) on the same lines.

Note that **Per draw** re-buckets the frame, which invalidates fragment counts
measured in the other mode (a per-draw bucket is a subset of a pipeline one, so
old counts can't be re-attributed). The graph clears them and says so; measure
again in the mode you want. Draw timings are keyed by the command itself and
survive the toggle.

## See also

* [Shader Debugger](shader_debugger.md) — step through a single invocation.
* [Capture](capture.md) — frame capture, pass timings and the overdraw view.
