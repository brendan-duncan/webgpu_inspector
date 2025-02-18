# Shader Debugger (Experimental)
[Overview](../README.md) . [Inspect](inspect.md) . [Capture](capture.md) . [Record](record.md)

## Introduction
###### [Back to top](#shader-debugger-experimental)

WebGPU Inspector lets you debug WGSL shaders, letting you step through shader code, set breakpoints, 
inspect variable values.

<div style="background-color: #ffedcc; color: #000; border-radius: 5px;">
<div style="background-color: #f0b37e; color: #fff; padding-left: 5px; padding-right: 5px;"><b>Warning</b></div>
<div style="padding-left: 5px; padding-right: 5px;">
<p>
The shader debugger is an <b>experimental</b> work in progress and not guaranteed to work on all shaders. It currently only supports <b>compute</b> shaders.
</p>
<p>
The shader debugger is a CPU interpreter of WGSL shaders. Because it does not actually run on the GPU, there will be some differences in how the shader is executed compared to running on the GPU. The shader debugger steps through a single thread of execution of the shader, whereas on the GPU the shader is SIMD multithreaded. This means some shader behaviors, like workgroup shared memory and barrier functions, will not behave the same with the shader debugger. The shader debugger is not suitable for debugging issues that invove these things, or issues like race conditions. The shader debugger is best suited for debugging things like shader logic issues.
</p>
</div>
</div>

## Debugging a compute shader
###### [Back to top](#shader-debugger-experimental)

The shader debugger is integrated into the [Capture](capture.md) tool. Capturing a frame will capture all buffers and textures used to render the frame.

<a href="images/shader_debugger_capture.png">
<img src="images/shader_debugger_capture.png" style="width:800px">
</a>

<div style="background-color: #ffedcc; color: #000; border-radius: 5px;">
<div style="background-color: #f0b37e; color: #fff; padding-left: 5px; padding-right: 5px;"><b>Warning</b></div>
<div style="padding-left: 5px; padding-right: 5px;">
<p>
To properly debug the shader, all buffers and textures used by the shader will need to have been captured. Large buffers may have been skipped, due to the <b>Max Buffer Size</b> capture property. If a buffer was skipped due to being too large, increase the Max Buffer Size to accomidate for the size needed by the buffer and capture the frame again.
</p>
</div>
</div>

Select a **dispatchWorkgroups** command from the capture. The command details will include the **Compute Module** used with the dispatch. Open the Compute module section and there will be a **Debug** button. Press the Debug button to start debugging the shader. This will open a tab with the debugger for the selected shader dispatch.

<a href="images/shader_debugger.png">
<img src="images/shader_debugger.png" style="width:800px">
</a>

## Debugger Controls
###### [Back to top](#shader-debugger-experimental)

### Thread ID

![Shader Debugger Thread ID](images/shader_debugger_thread_id.png)

The **Thread ID** is the **global_invocation_id** of the thread you wish to debug.
The **global_invocation_id** is based on the **dispatch workgroup_id** from the dispatch 
workgroup counts, and the local_invocation_id from the **workgroup_size** of the shader.

Enter the global_invocation_id you wish to debug and press the debug icon to start debugging
that invocation.

### Debugger Controls

![Shader Debugger Controls](images/shader_debugger_controls.png)

The shader debugger will start paused on the first statement of the compute shader kernel.
The toolbar at the top gives controls for stepping through the shader.

<img src="images/shader_debugger_controls_play_pause.png" style="width:45px"> Run from the current position all the way through to the end,
or until a breakpoint has been reached.

<img src="images/shader_debugger_controls_step_over.png" style="width:45px"> Execute the current statement, stepping over any function calls.

<img src="images/shader_debugger_controls_step_into.png" style="width:45px"> Execute the current statement, stepping into any function calls.

<img src="images/shader_debugger_controls_step_out.png" style="width:45px"> Run from the current position until the current block or function
has completed.

<img src="images/shader_debugger_controls_restart.png" style="width:45px"> Restart debugging the shader from the beginning.

<div style="background-color: #ffedcc; color: #000; border-radius: 5px;">
<div style="background-color: #f0b37e; color: #fff; padding-left: 5px; padding-right: 5px;"><b>Note</b></div>
<div style="padding-left: 5px; padding-right: 5px;">
<p>
The highlighted statement indicates the next statement to be executed, not the statement that was just executed.
</p>
</div>
</div>
