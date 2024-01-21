import { Widget } from './widget.js';
import { Signal } from './signal.js';

/**
 * A window widget fills the entire browser window. It will resize with the
 * browser. A Window can have an Overlay, which is a [Widget] that will be
 * resized to fill the entire window, and can be used to create full screen
 * modal editors.
 */
export class Window extends Widget {
  constructor(options) {
    super(document.body, options);
    this._overlay = null;
    this._onResizeCB = this.windowResized.bind(this);
    window.addEventListener('resize', this._onResizeCB);
    this.onWindowResized = new Signal();
    Widget.window = this;
  }

  windowResized() {
    this._onResize(window.innerWidth, window.innerHeight);
  }

  /**
   * @property {number} width The width of the widget.
   */
  get width() {
    return window.innerWidth;
  }

  /**
   * @property {number} heihgt The height of the widget.
   */
  get height() {
    return window.innerHeight;
  }

  /**
   * @property {Widget?} overlay The active overlay widget, which covers the entire window
   * temporarily.
   */
  get overlay() {
    return this._overlay;
  }

  set overlay(v) {
    if (this._overlay === v) return;

    if (this._overlay !== null)
      this._element.removeChild(this._overlay._element);

    this._overlay = v;

    if (this._overlay) {
      this._element.appendChild(this._overlay._element);
      this._overlay.setPosition(0, 0, 'absolute');
      this._overlay.resize(window.innerWidth, window.innerHeight);
    }
  }

  /**
   * The widget has been resized.
   * @param {number} width
   * @param {number} height
   */
  _onResize(width, height) {
    this.onWindowResized.emit();
    this.repaint();
    if (this._element) {
      if (this._overlay) this._overlay.resize(width, height);
    }
    this.onResize();
  }
}

Window.isWindow = true;
Window._idPrefix = 'WINDOW';
