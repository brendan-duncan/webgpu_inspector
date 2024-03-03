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

