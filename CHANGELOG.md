## v1.4.0

### Claude Code plugin / live capture

* **Captures no longer fail on size.** Large frames used to throw `Invalid string length` (V8's
  ~512MB string cap) and persist nothing. Captures are now streamed as NDJSON — small metadata plus
  out-of-band payload byte blobs — so no single huge string is ever built on the page, in the bridge,
  or on disk. Capture files are loadable in DevTools and via `load_capture_file`; older
  single-object `.json` captures still load.
* **The buffer size cap applies to every buffer.** `maxBufferSize` (default 64KB) now truncates
  vertex/index/storage/uniform/indirect buffer payloads consistently — previously only bind-group
  buffers were capped, so mesh-heavy frames still overflowed. Truncated payloads record their true
  length. The live bridge now honors `maxBufferSize` (it was previously ignored).
* **Texture size cap.** Captured textures larger than `maxTextureSize` (default 16MB) are skipped
  (descriptor still recorded) on the programmatic/bridge capture path, so a frame with full-res
  render targets stays light. DevTools-panel captures keep full-resolution textures by default for
  the texture viewer. Set `-1` to capture all texture data.
* **DevTools "Save Capture" no longer crashes on large frames.** A texture-heavy capture (hundreds
  of MB) used to crash the panel renderer while building the download. Save now streams NDJSON
  straight to disk via the File System Access API when available, and otherwise falls back to a
  memory-budgeted download (oversized payloads omitted, and reported) so the panel can't run out of
  memory.
* The bridge's single-upload limit was raised (default 2GB, configurable via
  `WEBGPU_INSPECTOR_MAX_UPLOAD_MB`) so texture-heavy captures aren't rejected; the capture is
  streamed to disk as it's received.
* **Scoped capture.** `capture_frames` gains `passLabel` (regex) and `passType` (`render`/`compute`)
  to capture heavy payloads only for matching passes, shrinking captures of large frames. `get_commands`
  gains a matching `passLabel` read-time filter.
* **New debugging tools:**
  * `get_draw_state` — resolves the full pipeline / bind groups / vertex+index bindings / draw params
    for a draw command, with the vertex layout and the command that captured each vertex buffer.
  * `decode_vertex_buffer` — decodes a captured vertex buffer's first N vertices into per-attribute
    numbers (all `GPUVertexFormat`s), so you can read e.g. `@location(2) (uv) = (0, 0)` directly.
  * `diff_draws` — structural diff of two draws' resolved state.
  * `read_buffer` — reads a live GPU buffer's current contents without taking a full capture.
* **MCP result hygiene.** Tool results are size-clamped (long strings/arrays truncated with a marker),
  `get_shader` truncates very large WGSL, and `get_capture_summary` can omit heavier fields.

## v1.3.0

### Record Panel

* **Save / Load menu**: a hamburger menu next to **Record** with **Save Binary** (`.wgpu`), **Save HTML** (a self-contained playback page), and **Load Binary**. A recording loaded in the panel — captured live or opened from a `.wgpu` — can be re-saved to either format, using a native "Save As" dialog where supported.
* **Edit recordings before saving**:
  * **Disable / enable commands**: a per-command checkbox (revealed on hover), plus a checkbox on each render/compute pass group header that toggles the whole pass. Disabled commands are dimmed, skipped in the preview, and dropped from the saved recording.
  * **Multi-select**: click, `Ctrl`/`Cmd`-click, and `Shift`-click to select commands (ranges may span frames), then right-click for bulk **Disable** / **Enable**.
  * **Hide Disabled** toggle to collapse disabled commands out of the list.
  * **Edit arguments**: each command argument is editable in the details pane — scalars inline, objects/arrays as JSON.
  * **Undo / Redo / Revert** with a **● Modified** indicator.
* **Implicit disabling**: disabling a command also disables what depends on it — every use of a disabled resource (cascading), both halves of a begin/end pass/debug-group/error-scope, and the draws that rely on disabled draw state. Conversely, a resource, draw-state command, or `createBuffer`/`writeBuffer`/`createTexture` left unused by any enabled command is disabled too. Foundational commands (`requestAdapter`, `requestDevice`, `getQueue`, `configure`) can't be disabled.
* **Compact saves**: disabled commands, and any buffer/texture data no longer referenced by an enabled command, are removed from the saved recording.
* The default record format is now **Binary** (`.wgpu`).
* Pass collapsible group headers now include the pass label when one is set.
* **Help** button linking to the Record documentation.
* The default preview mode is now **Full Frame**, and the Frame selector no longer stretches across the toolbar.
* Fixed an extra empty frame appearing for single-frame captures, and added a clear message when a captured frame contains no WebGPU commands.
* Fixed a crash (`Cannot read properties of null`) when capturing frames in **On Demand** / Continuous mode.

## v1.2.0

### Capture Panel

* **Profiling (Profile Passes)**: injects timestamp queries around render and compute passes. The data is presented in the frame capture as a timeline, to help identify what percentage of the frame the different passes are taking.

### Record Panel

* **Recording modes**: choose what to capture from the Mode dropdown — **Single Frame** (a specific frame by index), **Frame Range** (a contiguous range), **Multi-Frame** (an explicit list like `5,10`), or **On Demand** (run the page and capture frames with a **Capture Frame** button, with a **Continuous** option to keep capturing in the same session).
* **Output format**: record as a self-contained **HTML** file, a compact **Binary** (`.wgpu`) file with no base64 inflation, or **Both**.
* **Load Binary**: load a saved `.wgpu` binary recording back into the panel for playback.
* **Recording view**: redesigned into a three-column layout — preview canvas, command list (grouped by render/compute pass with pass labels and debug groups, plus a filter), and a command-details pane (method, arguments, result), reusing the Capture panel's command display. The preview can show either the selected command or the full frame, with a Frame selector for multi-frame recordings.
* Fixed command-selection and full-frame previews not rendering, and large recordings failing to stream to the panel.

### Inspect Panel

* Fixed the texture viewer's texel info tooltip adding extra page scrollbars near the window edges; it now stays within the viewport, repositioning when it would run off the bottom or right edge.

## v1.1.2

### Bug Fix

* Fix WebWorkers using modules erroring when trying to inspect them, saying 'fetch' had an invalid URL. Module WebWorkers should be inspectable now.

## v1.1.1

### Inspector Panel

* Add "Inspect Workers" option for Start inspection. When not checked, WebGPU Inspector will not try to inject into web workers. This can sometimes cause issues due to how this process happens. When checked, WebGPU Inspector will try to connect to web workers.

* WebGPU running from a web worker, inside of an iframe, is able to be inspected more reliably now.

### Manual Inspection

* Adding webgpu_inspector.js directly to a page will no longer try to inject itself into web workers, resolving issues where the worker injection mechanism caused other problems.

## v1.1.0

### Manual Inspection

* Added API to enable webgpu_inspector.js to be added to a html, with an API to start capture frames and save capture data from Javascript.

### Inspector Panel

* Filter displayed objects, making it easier to find objects of interest.

### Capture Panel

* Save and Load captures
* Open capture in new tab (right click on capture tab)
* Open capture in new window  (right click on capture tab)
* Misc fixes for compute shader debugging.

### Shader Debugger

* Variables panel: filter variables by name, and values that changed since the last step are highlighted.
* Callstack panel: shows each call frame with its current line, highlights the active frame, and clicking a frame jumps the editor to that line.
* Added a Detect Races button that runs the wgsl_reflect data-race detector, reporting data races and barrier issues caused by missing workgroup/storage barriers.

## v1.0.2 - April 04, 2026

* Optimize performance issues with the frame and object count plot widget.
* Fix error when inspecting a page that destructs the canvas texture.

## v1.0.1 - March 01, 2026

* Version updated to 1.0 to improve the version naming scheme.
* Refreshed styling for a cleaner look.
* Index Buffers view is now paginated to improve performance of viewing them.
* Fix null errors with texture views
* Version label is clickable and takes you to the github.

## v0.19.0 - January 19, 2026

* Fix requestAnimationFrame inspection breaking threejs pages.
* Shader Edtior: Compile button will stay visible when scrolling large shaders.
* Texture Viewer: Fix display of 1 channel textures.
* Texture Viewer: Fix display of u32 and i32 textures.
* Texture Viewer: Add Auto Range option, to normalize auto texture values for display.
* Texture Viewer: Display texture min and max values
* Texture Viewer: Left-click on texture will display pixel value on the texture info bar.

## v0.18.0 - December 28, 2025

* Improve connection from page to devtools panel.
* Fix capturing frames from multithreaded Wasm and iframes.

## v0.17.0 - December 17, 2025

* Zoomable texture views.
* Stacktrace lines link to source files.
* Fix text color for light color mode.
* Validation error text is now selectable.
* Improvements to capturing specific frames.

## v0.16.0

* Fix shader recompile on Firefox.
* Add back/forward inspection history navigation.

## v0.15.0

* Various fixes from wgsl_reflect for shader reflection and debugging.
* Fix issues with sites that have Workers.

## v0.14.0

* Fix shader debugger for shaders that have multiple entry points with differing sets of bindings. [33](https://github.com/brendan-duncan/webgpu_inspector/issues/33)
* UI improvements for frame captures:
  [29](https://github.com/brendan-duncan/webgpu_inspector/issues/29)
  [31](https://github.com/brendan-duncan/webgpu_inspector/issues/31)
* Fix setBindGroup being displayed multiple times in capture. [30](https://github.com/brendan-duncan/webgpu_inspector/issues/30)    
* Inspector shows all info from Adapter.

## v0.13.0

* Fix frame capture for content running in a worker thread.

## v0.12.0

* Various shader reflection library fixes.

## v0.11.0

* Compute shader debugger (experimental)
* Fix worker inspection error from importScripts, causing some pages to fail when inspected.

## v0.10.0

* Fix shader parse issue with literal values like "-1f".
* Capture can now record commands for compute-only programs, and for programs that do not use requestAnimationFrame.

## v0.9.0

* Fix issue with capturing dynamic offset uniform buffers.

## v0.8.0

* Inspect 3D textures.

## v0.5.0

* Automatically inject into WebWorkers.
* Inspect and capture RenderBundles.
* Improve capture display of vertex buffers.

## v0.4.0

* Fix Record for pages that use no buffer or texture data.
* Display depth texture min and max range values in Inspector.
* Recorder updates.

## v0.3.0

* Normalized depth texture preview, so depth textures can be visualized even if they are in compressed ranges.

## v0.2.0

* Use colors to improve readability of nested debug groups in a capture.
* Fix issue with capturing buffer data.
* Limit captured array buffer data view to improve UI performance and readability, with an Offset and Count to control the view of the array.

## v0.1.0

* Add ability to change radix of number views for buffer data.

## v0.0.9

* Make buffer data view more compact for basic types.
* Report memory leaks as a validation error (buffer/texture/device garbage collected without explicit destroy).
* You can edit the format used for viewing uniform and storage buffer data.

## v0.0.8

* Report an error if a canvas texture is used after it has expired.
* Ability to capture a specific frame.
* Inspect indirect buffers for draw*Indirect calls.
* Add filter for capture command list.

## v0.0.7

* Fix error when capturing frames when a BindGroup buffer uses a static offset.

## v0.0.6

* Improve Capture render and compute pass organization when passes use different command encoders.
* Inspect RG11B10 texture pixel values
* Preview depth textures

## v0.0.5

* Expand Inspector Descriptor display size
* Capture buffers when BindGroup doesn't have an explicit BindGroupLayout

## v0.0.4

* Fix multisampled texture preview
* Mark objects with errors as red in Object List
* Fix inspecting async render and compute pipelines
* Auto load textures in inspector
* Add channel select to texture viewer
* Refactor extension code, add Firefox support
    * Move extension code to src
    * Build **extensions/chrome** and **extensions/firefox**
        * Firefox only supports manifest v2, and Chrome supports manifest v3

