import { GPUObject } from "./gpu_object.js";

export class BindGroupLayout extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
BindGroupLayout.className = "BindGroupLayout";
