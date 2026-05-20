/**
 * Shared persistence for DevTools panel settings.
 *
 * Worker injection is on by default in the DevTools panel: the inspector
 * injects itself into Web Workers unless the user turns it off. The setting is
 * stored in localStorage so it survives DevTools being closed and reopened.
 * Both the Inspect panel (Start button) and the Capture panel read it, so a
 * panel-driven page reload always knows whether to inspect workers.
 * @module inspector_settings
 */

const INSPECT_WORKERS_KEY = "webgpu_inspector_inspect_workers";

/**
 * Whether the inspector should inject itself into Web Workers.
 * Defaults to true (enabled) when the user has not changed the setting.
 * @returns {boolean} True if worker inspection is enabled
 */
export function getInspectWorkers() {
  try {
    // Default on: only an explicit "false" disables it.
    return localStorage.getItem(INSPECT_WORKERS_KEY) !== "false";
  } catch (e) {
    return true;
  }
}

/**
 * Persist whether the inspector should inject itself into Web Workers.
 * @param {boolean} enabled - True to enable worker inspection
 */
export function setInspectWorkers(enabled) {
  try {
    localStorage.setItem(INSPECT_WORKERS_KEY, enabled ? "true" : "false");
  } catch (e) {
    // localStorage may be unavailable; the setting just won't persist.
  }
}
