class _MouseCapture {
  constructor() {
    this._initialized = false;
    this._captureWidget = null;
  }

  initialize() {
    if (this._initialized) return;
    this._initialized = true;
    document.addEventListener('mousemove', _MouseCapture._onMouseMove);
    document.addEventListener('mouseup', _MouseCapture._onMouseUp);
  }

  destroy() {
    if (!this._initialized) return;
    this._initialized = false;
    document.removeEventListener('mousemove', _MouseCapture._onMouseMove);
    document.removeEventListener('mouseup', _MouseCapture._onMouseUp);
  }

  get captureWidget() {
    return this._captureWidget;
  }

  startCapture(widget) {
    if (!this._initialized) this.initialize();
    if (this._captureWidget === widget) return;
    this._captureWidget = widget;
  }

  endCapture() {
    this._captureWidget = null;
  }

  static _onMouseMove(e) {
    if (MouseCapture._captureWidget)
      MouseCapture._captureWidget._onMouseMove(e);
  }

  static _onMouseUp(e) {
    if (MouseCapture._captureWidget) MouseCapture._captureWidget._onMouseUp(e);
  }
}

export let MouseCapture = new _MouseCapture();
