// WebGPU Recorder code comes from https://github.com/brendan-duncan/webgpu_recorder.
// It is injected here by the npm rollup build process.
import coreLoader from "webgpu_recorder_core_func";

const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
const recorderMessage = sessionStorage.getItem(webgpuRecorderLoadedKey);

// Parse a recordFrame field (a possibly-empty comma-joined list of absolute frame indices) into
// the form the recorder expects: null (wait for a trigger), a single number, or an array.
function parseRecordFrame(str) {
  if (str === undefined || str === null || str === "") {
    return null;
  }
  if (str.indexOf(",") !== -1) {
    return str.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
  }
  const n = parseInt(str, 10);
  return isNaN(n) ? null : n;
}

if (recorderMessage) {
  sessionStorage.removeItem(webgpuRecorderLoadedKey);

  // Field order: frames%filename%download%recordMode%recordFrame%continuous%output
  const data = recorderMessage.split("%");
  const frames = data[0];
  const filename = data[1];
  const dl = data[2];
  const recordMode = data[3] ? parseInt(data[3], 10) || 0 : 0;
  const recordFrame = parseRecordFrame(data[4]);
  const continuous = data[5] === "true";
  const output = data[6] || "html";
  const removeUnusedResources = true;
  const messageRecording = true;

  const download = dl === null ? true : dl === "false" ? false : dl === "true" ? true : dl;

  self._webgpu_recorder_init = {
    export: filename,
    frames,
    download,
    removeUnusedResources,
    messageRecording,
    recordMode,
    recordFrame,
    continuous,
    output
  };

  self.__webgpu_src = coreLoader;
  self.__webgpu_src();
}

if (window) {
  window.addEventListener("__WebGPURecorder", (event) => {
    const message = event.detail || event.data;
    if (typeof message !== "object" || !message.__webgpuRecorder) {
      return;
    }
    if (message.action === "webgpu_recorder_start_recording") {
      if (!self.__webgpu_src) {

        //const data = recorderMessage.split("%");
        const frames = message.frames;
        const filename = message.export;
        const dl = message.download;
        const recordMode = message.recordMode ?? 0;
        const recordFrame = typeof message.recordFrame === "string"
          ? parseRecordFrame(message.recordFrame)
          : (message.recordFrame ?? null);
        const continuous = !!message.continuous;
        const output = message.output || "html";
        const removeUnusedResources = true;
        const messageRecording = true;

        const download = dl === null ? true : dl === "false" ? false : dl === "true" ? true : dl;

        self._webgpu_recorder_init = {
          export: filename,
          frames,
          download,
          removeUnusedResources,
          messageRecording,
          recordMode,
          recordFrame,
          continuous,
          output
        };

        self.__webgpu_src = coreLoader;
        self.__webgpu_src();
      }
    }
  });
}
