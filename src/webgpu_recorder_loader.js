// WebGPU Recorder code comes from https://github.com/brendan-duncan/webgpu_recorder.
// It is injected here by the npm rollup build process.
import coreLoader from "webgpu_recorder_core_func";

const webgpuRecorderLoadedKey = "WEBGPU_RECORDER_LOADED";
const recorderMessage = sessionStorage.getItem(webgpuRecorderLoadedKey);

if (recorderMessage) {
  sessionStorage.removeItem(webgpuRecorderLoadedKey);

  const data = recorderMessage.split("%");
  const frames = data[0];
  const filename = data[1];
  const dl = data[2];
  const removeUnusedResources = true;
  const messageRecording = true;

  const download = dl === null ? true : dl === "false" ? false : dl === "true" ? true : dl;

  self._webgpu_recorder_init = {
    filename,
    frames,
    download,
    removeUnusedResources,
    messageRecording
  };
 
  self.__webgpu_src = coreLoader;
  self.__webgpu_src();
}
