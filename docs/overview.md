[Inspect](inspect.md) . [Capture](capture.md) . [Record](record.md)

# WebGPU Inspector

The WebGPU Inspector extension is available from the Developer Tools window.

#### Opening the Developer Tools window
Select __More Tools / Developer Tools__, or press __F12__ or __Shit+CTRL+J__ (__Option + ⌘ + J__ on MacOS). You can also right-click on the page and select __Inspect__. When the WebGPU Inspector extension is enabled in the extension manager, there will be a **WebGPU Inspector** tab.

![WebGPU Inspector Panel](images/webgpu_inspector_panel.png)

#### Problem Solving

If the WebGPU Inspector tab is not present on the Developer Tools panel, try closing the Developer Tools window and opening it again. Sometimes the browser doesn't load the extension.



## [Inspect](inspect.md)

[Inspect](inspect.md) reports all GPU objects that have been created and lets you inspect information about them, and in some cases edit them.

![WebGPU Inspector](images/inspect.png)

## [Capture](capture.md)

[Capture](capture.md) records all WebGPU commands used to render a frame and generates a report, letting you inspect each command, including rendering state and the image results of each render pass.

![Capture](images/capture.png)

## [Record](record.md)

[Record](record.md) records all WebGPU commands and their associated data, generating an HTML file with inlined Javascript that recreates the rendered frames. This lets you open the recording file in a browser to replay the render, and edit the javascript to test out changes independently of the engine used to create the render. It can also be used to create reproduction test cases for bug reports, to isolate the graphics issue separate from the engine.

![Record](images/record.png)
