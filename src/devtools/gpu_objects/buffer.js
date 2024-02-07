import { GPUObject } from "./gpu_object.js";

export class Buffer extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
Buffer.className = "Buffer";
