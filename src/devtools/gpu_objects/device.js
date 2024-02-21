import { GPUObject } from "./gpu_object.js";

export class Device extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, descriptor, stacktrace);
    this.descriptor = descriptor;
  }
}
Device.className = "Device";
