import { Widget } from './widget.js';

export class Img extends Widget {
  constructor(parent, options) {
    super('img', parent, options);
  }

  get src() {
    return this.element.src;
  }

  set src(v) {
    this.element.src = v;
  }

  configure(options) {
    if (!options) {
      return;
    }
    super.configure(options);
    if (options.src !== undefined) {
      this.element.src = options.src;
    }
  }
}
