import { GPUObject } from "./gpu_object.js";

export class BindGroup extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
BindGroup.className = "BindGroup";
