export function webgpuInspectorHandler(worker) {
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
      window.postMessage(event.data, "*");
    }
  });

  window.addEventListener("message", (event) => {
    // Forward messages from the page to the worker, if the worker hasn't been terminated,
    // the message is from the inspector, and the message is not from the worker.
    if (worker.__webgpuInspector && event.data.__webgpuInspector &&
      !event.data.__webgpuInspectorPage) {
      worker.postMessage(event.data);
    }
  });
}
