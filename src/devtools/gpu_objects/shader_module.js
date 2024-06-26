import { GPUObject } from "./gpu_object.js";
import { WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";

export class ShaderModule extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, descriptor, stacktrace);
    this._reflection = null;
    this.descriptor = descriptor;
    this.hasVertexEntries = descriptor?.code ? descriptor.code.indexOf("@vertex") != -1 : false;
    this.hasFragmentEntries = descriptor?.code ? descriptor.code.indexOf("@fragment") != -1 : false;
    this.hasComputeEntries = descriptor?.code ? descriptor.code.indexOf("@compute") != -1 : false;
    this.replacementCode = null;

    this.isDestroyed = false;
  }

  get code() {
    return this.replacementCode ?? this.descriptor?.code ?? "";
  }

  get reflection() {
    if (this._reflection === null) {
      try {
        this._reflection = new WgslReflect(this.code);
      } catch (e) {
        this._reflection = null;
      }
    }
    return this._reflection;
  }
}
ShaderModule.className = "ShaderModule";
