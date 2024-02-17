## v0.0.5
* 02/17/2024
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

