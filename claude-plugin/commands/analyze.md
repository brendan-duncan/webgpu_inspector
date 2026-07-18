---
description: Analyze a WebGPU Inspector capture for performance and correctness issues
argument-hint: [capture id or file path]
---

Analyze a WebGPU Inspector capture in depth.

`$ARGUMENTS` may be a capture id (e.g. `cap-2`), a path to a saved capture
file (`.wgpuc`, or legacy `.json`), or empty (use the most recent capture).

Do this:

1. If `$ARGUMENTS` looks like a file path, call `load_capture_file` with it.
   Otherwise call `list_captures`; pick the capture matching `$ARGUMENTS`, or
   the most recent one if `$ARGUMENTS` is empty. If there are no captures,
   tell the user to run `/webgpu-inspector:capture` first and stop.
2. Call `get_capture_summary` for that capture.
   - If the request is about **performance** (slow, janky, dropped frames,
     bottleneck, CPU/GPU bound, fillrate, "where's the time going"), also call
     `analyze_performance` for the frame-budget/bound verdict, per-pass GPU-time
     ranking, and improvement suggestions. If the summary has no `gpuTiming`
     (the capture wasn't taken with `profilePasses: true`) and a page is still
     connected, offer to re-capture with `capture_frames({ profilePasses: true,
     payloads: "none" })` so passes carry real GPU timings — don't wait to be
     asked to enable it. `get_frame_stats` gives a live fps / dropped-frame /
     bound read without a capture.
3. For each entry in `issues`, confirm and explain it using `get_commands`
   (pass the reported `commandIndices`), `get_object`, and `get_shader`.
4. Review the shaders involved with `get_shader`; check the WGSL for obvious
   inefficiencies relevant to the captured workload.
5. Call `get_validation_errors` and explain any that are present.
6. Give the user a prioritized list of findings. For each: severity, what it
   is, why it matters, and a concrete fix — citing command indices and object
   ids so they can locate it in the WebGPU Inspector DevTools panel.

Use the `webgpu-capture-analysis` skill for guidance on interpreting the data.
