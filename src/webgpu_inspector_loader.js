// WebGPU Inspector code is injected here by the npm rollup build process.
import coreLoader from "webgpu_inspector_core_func";

const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";
// Set by content_script.js from the DevTools panel's "Inspect Workers"
// setting. Tells the inspector whether to inject itself into Web Workers.
const webgpuInspectorWorkersKey = "WEBGPU_INSPECTOR_WORKERS";

// The Inspector doesn't start listening for WebGPU calls until it is instructed
// to do so. Otherwise we would be adding ovearhead to all WebGPU applications
// even when the inspector is not being used.

// Check session storage to see if we should start the inspector.
// This happens when you start the inspector from the devtools panel.
// That action will set the session storage key and then reload the page.
// When the page reloads we see the key here and start the inspector.
const inspectMessage = sessionStorage.getItem(webgpuInspectorLoadedKey);
if (inspectMessage) {
  // Defer removal until the window's load event. Same-origin iframes share
  // sessionStorage with the top frame: if the first loader to run removes
  // the key immediately, the other frames' loaders see null at their own
  // document_start and never start their inspectors. That in particular
  // breaks workers created in iframes, because the Worker proxy is only
  // installed once the inspector starts, so any worker spawned by the
  // iframe before that proxy is in place runs unpatched.
  //
  // By the time load fires, every frame's loader has already read the
  // value, so the cleanup is still complete in time to keep subsequent
  // navigations from auto-starting the inspector.
  window.addEventListener("load", () => {
    sessionStorage.removeItem(webgpuInspectorLoadedKey);
    sessionStorage.removeItem(webgpuInspectorWorkersKey);
  }, { once: true });

  if (inspectMessage !== "true") {
    sessionStorage.setItem(webgpuInspectorCaptureFrameKey, inspectMessage);
  }

  // webgpu_inspector.js reads this global when deciding whether to install its
  // Worker proxy. The DevTools panel's "Inspect Workers" setting controls it
  // (on by default). Manual <script>-tag injection never runs this loader, so
  // worker injection stays off for manual injection.
  self.__webgpuInspectorInspectWorkers =
    sessionStorage.getItem(webgpuInspectorWorkersKey) === "true";

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
        self.__webgpuInspectorInspectWorkers = !!message.inspectWorkers;
        self.__webgpu_src = coreLoader;
        self.__webgpu_src();
      }
    }
  });
}
