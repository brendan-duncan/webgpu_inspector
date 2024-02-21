import { GPUObject } from "./gpu_object.js";

export class PipelineLayout extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, descriptor, stacktrace);
    this.descriptor = descriptor;
  }
}
PipelineLayout.className = "PipelineLayout";
