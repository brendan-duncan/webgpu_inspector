import { GPUObject } from "./gpu_object.js";

export class Adapter extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
Adapter.className = "Adapter";
