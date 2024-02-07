import { GPUObject } from "./gpu_object.js";

export class ComputePipeline extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
ComputePipeline.className = "ComputePipeline";
