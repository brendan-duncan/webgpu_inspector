// WebGPU Inspector code is injected here by the npm rollup build process.
import coreLoader from "webgpu_inspector_core_func";

const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

// The Inspector doesn't start listening for WebGPU calls until it is instructed
// to do so. Otherwise we would be adding ovearhead to all WebGPU applications
// even when the inspector is not being used.

// Check session storage to see if we should start the inspector.
// This happens when you start the inspector from the devtools panel.
// That action will set the session storage key and then reload the page.
// When the page reloads we see the key here and start the inspector.
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
  // Listen for a custom event to start the inspector. If we get the event
  // that instructs us to start inspection, then we start the inspector code.
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
