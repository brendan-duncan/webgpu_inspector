export const Actions = {
  CaptureBufferData: "webgpu_inspect_capture_buffer_data",
  CaptureBuffers: "webgpu_inspect_capture_buffers",
  DeleteObjects: "webgpu_inspect_delete_objects",
  ValidationError: "webgpu_inspect_validation_error",
  MemoryLeakWarning: "webgpu_inspect_memory_leak_warning",
  DeltaTime: "webgpu_inspect_delta_time",
  CaptureFrameResults: "webgpu_inspect_capture_frame_results",
  CaptureFrameCommands: "webgpu_inspect_capture_frame_commands",
  ObjectSetLabel: "webgpu_inspect_object_set_label",
  AddObject: "webgpu_inspect_add_object",
  ResolveAsyncObject: "webgpu_inspect_resolve_async_object",
  DeleteObject: "webgpu_inspect_delete_object",
  CaptureTextureFrames: "webgpu_inspect_capture_texture_frames",
  CaptureTextureData: "webgpu_inspect_capture_texture_data",
  CaptureBufferData: "webgpu_inspect_capture_buffer_data",

  Recording: "webgpu_record_recording"
};

Actions.values = new Set(Object.values(Actions));

export const PanelActions = {
  RequestTexture: "webgpu_inspect_request_texture",
  CompileShader: "webgpu_inspect_compile_shader",
  Capture: "webgpu_inspector_capture",
  InitializeInspector: "webgpu_initialize_inspector",
  InitializeRecorder: "webgpu_initialize_recorder"
};
