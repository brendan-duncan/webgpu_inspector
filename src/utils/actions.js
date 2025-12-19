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
  WriteBuffer: "wrebgpu_inspect_write_buffer",

  Recording: "webgpu_record_recording",
  RecordingCommand: "webgpu_record_command",
  RecordingDataCount: "webgpu_record_data_count",
  RecordingData: "webgpu_record_data",

  // Connection handshake actions
  PageReady: "webgpu_inspect_page_ready",
  PanelReady: "webgpu_inspect_panel_ready",
  ConnectionAck: "webgpu_inspect_connection_ack"
};

Actions.values = new Set(Object.values(Actions));

export const PanelActions = {
  RequestTexture: "webgpu_inspect_request_texture",
  CompileShader: "webgpu_inspect_compile_shader",
  RevertShader: "webgpu_inspect_revert_shader",
  Capture: "webgpu_inspector_capture",
  InitializeInspector: "webgpu_initialize_inspector",
  InitializeRecorder: "webgpu_initialize_recorder"
};
