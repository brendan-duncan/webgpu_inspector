import { GPUObject } from "./gpu_object.js";

export class BindGroup extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, descriptor, stacktrace);
    this.descriptor = descriptor;
  }

  get entries() {
    return this.descriptor?.entries;
  }
}
BindGroup.className = "BindGroup";
