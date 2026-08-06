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
4. Zoom into the widest shader stage and look at the color: red says cut texture
   work, purple says cut buffer traffic, orange says a transcendental is in a
   loop.
5. Cross-check against **Analyze Shaders**, which flags specific patterns
   (expensive builtins in loops, loop-invariant expressions) on the same lines.

## See also

* [Shader Debugger](shader_debugger.md) — step through a single invocation.
* [Capture](capture.md) — frame capture, pass timings and the overdraw view.
