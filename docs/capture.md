# Capture
[Overview](../README.md) . [Inspect](inspect.md) . [Record](record.md)

* [Introduction](#introduction)
* [Capturing Frame Data](#capturing-frame-data)
* [Frame Commands](#frame-commands)
* [Render Pass Textures](#render-pass-textures)
* [Command Stacktrace](#command-stacktrace)
* [Command Inspection](#command-inspection)
* [Uniform and Storage Buffer Inspection](#uniform-and-storage-buffer-inspection)
    * [Formatting Buffer Data](formatting_buffer_data.md)
* [Frame Stats](#frame-stats)
* [Shader Debugger](#shader-debugger)

## Introduction
###### [Back to top](#capture)

Capture all rendering commands used to render a frame, letting you inspect each command, as well as providing information about the rendering state at each command. It also captures the image results of each render pass.

<a href="images/capture.png">
<img src="images/capture.png" style="width:800px">
</a>

## Capturing Frame Data
###### [Back to top](#capture)

Press the **Capture** button to capture a frame from the page.

### Capture Mode

Capture has two modes: **Immediate** and **Specific Frame**.

#### Immediate Capture

![Capture Button](images/capture_button.png)

Immediate capture will record the current frame on the page.

**Frames** indicates how many frames to capture.

#### Specific Frame Capture

![Capture Button](images/capture_specific_frame.png)

Specific frame capture will record a specific frame from the load of the page. Using this capture mode will cause the page to refresh, and start recording at the indicated frame.

A start frame of **0** will record all commands from the start of the page load, including those outside of a requestAnimationFrame frame. This allows you to capture commands for pages that do not use requestAnimationFrame.

**Frames** indicates how many frames to capture once it has started recording.

For pages that do not use requestAnimationFrame, the Frames valu does not do anything. In that case, recording will continue until the GPU device has been destroyed or gabage collected, or you press the inspector overlay on the page to stop the recording.

#### Max Buffer Size

The **Max Buffer Size** value specifies the maximum buffer size Capture will record, for Uniform and Storage buffers. Sending buffer data to the DevTools panel can be slow, so limiting the buffer size can help capture performance. Large buffers are typically used for storage buffers.

#### Note

Frame capture works best when requestAnimationFrame is used, as Capture uses that to identify what commands to capture for a frame. Immediate capture will not work without requestAnimationFrame. In that case, use **Specific Frame** capture with frame 0, to start recording after page load.


## Frame Commands
###### [Back to top](#capture)

Capture will record all GPU commands issued during a frame, including their arguments, and the stackrace of where it was called.

Selecting a command will display information about the command, including associated GPU objects.

<a href="images/frame_capture_commands.png">
<img src="images/frame_capture_commands.png" style="width:512px">
</a>

## Render Pass Textures

The color texture attachments of Render Passes will be captured and displayed in the capture panel.

Selecting a Render Pass image will select the associated beginRenderPass command.

![Capture Render passes](images/capture_render_passes.png)

## Command Stacktrace
###### [Back to top](#capture)

Each command will record the stacktrace of where it was executed.

![Command Stacktrace](images/capture_stacktrace.png)

## Command Inspection
###### [Back to top](#capture)

Selecting a command will display information about the command, including its arguments and information about objects related to the command.

![Command Inspection](images/capture_command_state.png)

## Uniform and Storage Buffer Inspection
###### [Back to top](#capture)

If you select a Draw or Dispatch command, it will inspect the BindGroups and Pipeline active for the command. It will inspect the Buffer objects associated with the BindGroups, and parse their data based on the shaders associated the the Pipeline. This lets you inspect buffer data as the shader will see it during the Draw or Dispatch command.

**Affected By** lists the commands that have written to this particular buffer.

**Format** lets you customize the format of the buffer data. See [Formatting Buffer Data](formatting_buffer_data.md) for more information.

<a href="images/buffer_data_inspection.png">
<img src="images/buffer_data_inspection.png" style="width:512px">
</a>

### Array Data

Array data can be quite large. To improve performance and readability, if the array has more than 100 elements, only a subset of array data is viewed. 

**Offset** is the starting index of the array to view.

**Count** is the number of elements of the array to view.

<a href="images/buffer_array_inspection.png">
<img src="images/buffer_array_inspection.png" style="width:512px">
</a>

## Vertex Buffer Data

If you select a Draw command, it will inspect any Vertex Buffers bound for the draw call. It will parse the data from the RenderPipeline descriptor, and the shader, to present the data as the shader will see it.

<a href="images/vertex_buffer_capture.png">
<img src="images/vertex_buffer_capture.png" style="width:512px">
</a>

## Debug Groups

If the page pushes/pops Debug Groups, they will be be used to group commands in the capture. This is useful for organizing rendering commands to make it easier to identify what the commands are contributing to the render.

<a href="images/capture_debug_groups.png">
<img src="images/capture_debug_groups.png" style="width:512px">
</a>

## Frame Stats
###### [Back to top](#capture)

The Capture tool can provide various statistics about the capture. Press the **Frame Stats** to show the capture statistics. These include how many graphics commands were called; how many draw calls; and so on.

<a href="images/capture_frame_stats.png">
<img src="images/capture_frame_stats.png" style="width:512px">
</a>

## Shader Debugger
###### [Back to top](#capture)

Frame captures include the ability to debug shaders. This is an experimental feature, with only compute shaders currently supported.

**[Shader Debugger](shader_debugger.md)**

<a href="shader_debugger.md">
<img src="images/shader_debugger.png" style="width:800px">
</a>
