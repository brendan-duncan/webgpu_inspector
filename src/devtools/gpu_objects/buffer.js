import { GPUObject } from "./gpu_object.js";

export class Buffer extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, descriptor, stacktrace);
    this.descriptor = descriptor;
  }
}
Buffer.className = "Buffer";
