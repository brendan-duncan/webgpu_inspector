import { StacktraceCache } from "../../utils/stacktrace.js";

export class GPUObject {
  constructor(id, descriptor, stacktrace) {
    this.id = id;
    this.label = descriptor?.label ?? "";
    this._stacktrace = StacktraceCache.setStacktrace(stacktrace ?? "");
    this._deletionTime = 0;
    this._referenceCount = 1;
    this.dependencies = [];
    // Reverse edges of 'dependencies': the objects created from this one. WebGPU has no destroy() for
    // texture views or bind groups, so when a texture is destroyed these are the only way to know that its
    // views are gone and that bind groups holding them can no longer be used. A Set, so that removing one
    // of a texture's or buffer's many dependents stays O(1) (see ObjectDatabase._deleteObject).
    this.dependents = new Set();
    // Set when a resource this object references was destroyed, e.g. a bind group whose texture is gone.
    this.invalidReason = null;
  }

  get name() {
    return this.label || this.constructor.className;
  }

  get stacktrace() {
    return StacktraceCache.getStacktrace(this._stacktrace);
  }

  get isDeleted() {
    return this._deletionTime > 0;
  }

  get idName() {
    return this.id < 0 ? "CANVAS" : this.id;
  }

  get referenceCount() {
    return this._referenceCount;
  }

  get isInvalid() {
    return this.invalidReason !== null;
  }

  addDependency(dependency) {
    if (dependency) {
      this.dependencies.push(dependency);
      dependency.dependents.add(this);
    }
  }

  incrementDepenencyReferenceCount() {
    for (const dependency of this.dependencies) {
      dependency._referenceCount++;
      dependency.incrementDepenencyReferenceCount();
    }
  }

  incrementReferenceCount() {
    this._referenceCount++;
  }

  decrementReferenceCount(deleteCallback) {
    this._referenceCount--;
    if (this._referenceCount <= 0) {
      if (deleteCallback) {
        deleteCallback(this);
      }
    }
    for (const dependency of this.dependencies) {
      dependency.decrementReferenceCount(deleteCallback);
    }
  }
}
