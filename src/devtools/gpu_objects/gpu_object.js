import { StacktraceCache } from "../../utils/stacktrace.js";

export class GPUObject {
  constructor(id, descriptor, stacktrace) {
    this.id = id;
    this.label = descriptor?.label ?? "";
    this._stacktrace = StacktraceCache.setStacktrace(stacktrace ?? "");
    this._deletionTime = 0;
    this._referenceCount = 1;
    this.dependencies = [];
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

  addDependency(dependency) {
    if (dependency) {
      this.dependencies.push(dependency);
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
