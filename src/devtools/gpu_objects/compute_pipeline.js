import { GPUObject } from "./gpu_object.js";

export class ComputePipeline extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, descriptor, stacktrace);
    this.descriptor = descriptor;
  }
}
ComputePipeline.className = "ComputePipeline";
