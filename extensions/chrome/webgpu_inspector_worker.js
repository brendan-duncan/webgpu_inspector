var __webgpu_inspector_worker = (function (exports) {
  'use strict';

  function webgpuInspectorWorker(worker) {
    if (worker.__webgpuInspector) {
      return;
    }

    worker.__webgpuInspector = true;

    // Intercept worker termination and remove it from list so we don't send
    // messages to a terminated worker.
    if (worker.terminate) {
      const __terminate = worker.terminate;
      worker.terminate = function () {
        const result = __terminate.call(worker, ...arguments);
        worker.__webgpuInspector = false;
        return result;
      };
    }

    worker.addEventListener("message", (event) => {
      if (event.data.__webgpuInspector) {
        window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: event.data }));
      }
    });

    window.addEventListener("__WebGPUInspector", (event) => {
      // Forward messages from the page to the worker, if the worker hasn't been terminated,
      // the message is from the inspector, and the message is not from the worker.
      if (worker.__webgpuInspector && event.detail.__webgpuInspector &&
        !event.detail.__webgpuInspectorPage) {
        worker.postMessage(event.detail);
      }
    });
  }

  exports.webgpuInspectorWorker = webgpuInspectorWorker;

  Object.defineProperty(exports, '__esModule', { value: true });

  return exports;

})({});
//# sourceMappingURL=webgpu_inspector_worker.js.map
