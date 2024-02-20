export class GPUObjectRef {
  constructor(object) {
    this.object = object;
    this.referenceCount = 1;
  }

  addReference() {
    this.referenceCount++;
  }

  removeReference() {
    this.referenceCount--;
    if (this.referenceCount === 0) {
      this.object.destroy();
    }
  }
}
