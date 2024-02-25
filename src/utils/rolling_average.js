export class RollingAverage {
  constructor(windowSize) {
    this.windowSize = windowSize;
    this.buffer = [];
    this.sum = 0;
  }
  
  add(frameTime) {
    this.buffer.push(frameTime);
    if (this.buffer.length > this.windowSize) {
      this.sum -= this.buffer.shift();
    }
    this.sum += frameTime;
  }
  
  get average() {
    return this.sum / this.buffer.length;
  }
}
