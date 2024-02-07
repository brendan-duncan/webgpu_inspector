import { GPUObject } from "./gpu_object.js";

export class RenderPipeline extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }

  get topology() {
    return this.descriptor?.primitive?.topology ?? "triangle-list";
  }
}
RenderPipeline.className = "RenderPipeline";
