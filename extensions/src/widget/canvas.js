import { Widget } from './widget.js';

/**
 * A Canvas widget provides methods for managing a Canvas element.
 */
export class Canvas extends Widget {
  constructor(parent, options) {
    super('canvas', parent, options);
    this.classList.add('canvas');
  }

  configure(options) {
    super.configure(options);
    if (options.width !== undefined) this.element.width = options.width;
    if (options.height !== undefined) this.element.height = options.height;
  }

  /**
   * Returns a data URI containing a representation of the image in the
   * format specified by type (defaults to 'image/png').
   * Data Uri format is as follow
   * `data:[<MIME-type>][;charset=<encoding>][;base64],<data>`
   * @param {String} [format]
   */
  toDataUrl(format) {
    format = format || 'image/png';
    return this._element.toDataUrl(format);
  }

  onAddedToWindow(w) {
    this.paintEvent();
    w.onWindowResized.addListener(this._onWindowResize, this);
    this._onWindowResize();
  }

  _onWindowResize() {
    this.element.width = 0;
    this.element.height = 0;
    this.paintEvent();
  }

  startResize() {
    this.element.width = 0;
    this.element.height = 0;
  }

  paintEvent() {
    if (!this.visible) return;
    if (
      this.width != this.element.width ||
      this.height != this.element.height
    ) {
      this.element.width = this.width;
      this.element.height = this.height;
    }
  }

  get context2D() {
    return this.element.getContext('2d');
  }
}

Canvas.isCanvas = true;
Canvas._idPrefix = 'CANVAS';
