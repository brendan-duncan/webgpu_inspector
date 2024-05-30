import coreLoader from "webgpu_inspector_core_func";

const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";
const inspectMessage = sessionStorage.getItem(webgpuInspectorLoadedKey);

if (inspectMessage) {
  sessionStorage.removeItem(webgpuInspectorLoadedKey);

  if (inspectMessage !== "true") {
    sessionStorage.setItem(webgpuInspectorCaptureFrameKey, inspectMessage);
  }

  self.__webgpu_src = coreLoader;
  self.__webgpu_src();
}
