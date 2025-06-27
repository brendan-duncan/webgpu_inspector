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

