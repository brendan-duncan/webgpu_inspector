import { GPUObject } from "./gpu_object.js";

export class Sampler extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
Sampler.className = "Sampler";
