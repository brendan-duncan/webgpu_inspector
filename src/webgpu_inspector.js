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

if (window) {
  window.addEventListener("__WebGPUInspector", (event) => {
    const message = event.detail || event.data;
    if (typeof message !== "object" || !message.__webgpuInspector) {
      return;
    }
    if (message.action === "webgpu_inspector_start_inspection") {
      if (!self.__webgpu_src) {
        self.__webgpu_src = coreLoader;
        self.__webgpu_src();
      }
    }
  });
}
