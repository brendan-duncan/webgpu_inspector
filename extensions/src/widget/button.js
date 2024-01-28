import { Widget } from './widget.js';

export class Button extends Widget {
  constructor(parent, options) {
    super('button', parent);
    this.classList.add('button');

    this.callback = null;
    this.onMouseDown = null;
    this.onMouseUp = null;

    this._click = this.click.bind(this);
    this._mouseDown = this.mouseDown.bind(this);
    this._mouseUp = this.mouseUp.bind(this);

    this.element.addEventListener('click', this._click);
    this.element.addEventListener('mousedown', this._mouseDown);
    this.element.addEventListener('mouseup', this._mouseUp);

    if (options) {
      this.configure(options);
    }
  }

  configure(options) {
    super.configure(options);
    if (options.callback) {
      this.callback = options.callback;
    }
    if (options.mouseDown) {
      this.onMouseDown = options.mouseDown;
    }
    if (options.mouseUp) {
      this.onMouseUp = options.mouseUp;
    }
    if (options.label) {
      this.text = options.label;
    }
  }

  click(event) {
    if (this.callback) {
      this.callback.call(this, event);
    }
  }

  mouseDown(event) {
    if (this.onMouseDown) {
      this.onMouseDown.call(this, event);
    }
  }

  mouseUp(event) {
    if (this.onMouseUp) {
      this.onMouseUp.call(this, event);
    }
  }
}
