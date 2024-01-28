import { Widget } from './widget.js';

export class Label extends Widget {
  constructor(text, parent, options) {
    super('label', parent, options);
    this.classList.add('label');
    this.text = text;
  }

  configure(options) {
    if (!options) {
      return;
    }
    super.configure(options);
    if (options.for) {
      this.for = options.for;
    }
  }

  get for() {
    return this._element.htmlFor;
  }

  set for(v) {
    if (!v) {
      this._element.htmlFor = '';
    } else if (v.constructor === String) {
      this._element.htmlFor = v;
    } else {
      this._element.htmlFor = v.id;
    }
  }
}
