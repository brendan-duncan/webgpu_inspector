import { Pointer } from './pointer.js';

/**
 * A Widget is a wrapper for a DOM element.
 */
export class Widget {
  constructor(element, parent, options) {
    this.id = `${this.constructor.name}${Widget.id++}`;
    if (element && element.constructor === String) {
      element = document.createElement(element);
    }

    this._element = element;
    if (element) {
      this._element.id = this.id;
      this._element.title = '';
    }

    if (parent && parent.constructor === Object) {
      options = parent;
      parent = null;
    }

    this._parent = null;
    this.children = [];

    /*this.hasFocus = false;
    this.mouseX = 0;
    this.mouseY = 0;
    this.mousePageX = 0;
    this.mousePageY = 0;

    this._mouseDownEnabled = false;
    this._mouseMoveEnabled = false;
    this._mouseUpEnabled = false;
    this._clickEnabled = false;
    this._contextMenuEnabled = false;
    this._doubleClickEnabled = false;
    this._mouseWheelEnabled = false;
    this._mouseOverEnabled = false;
    this._mouseOutEnabled = false;
    this._keyPressEnabled = false;
    this._keyReleaseEnabled = false;
    this._touchEventsEnabled = false;
    this._pointerEventsEnabled = false;
    this._isMouseDown = false;
    // The button that is down during the onMouseDown event.
    // This should be used during mouseMoveEvent, as MouseEvent.button isn't
    // going to work on anything but Chrome.
    this.mouseButton = -1;*/

    // Latest state of the tracked pointers.
    //this.currentPointers = [];

    //this.enableContextMenuEvent();

    if (parent) {
      if (parent.constructor.isLayout) {
        const stretch = options && options.stretch ? options.stretch : 0;
        parent.add(this, stretch);
      } else {
        this.parent = parent;
      }
    }

    if (options) {
      this.configure(options);
    }

    if (this._element) {
      this._element.widget = this;
    }
  }

  configure(options) {
    if (options.id) {
      this._element.id = options.id;
    }

    if (options.class) {
      if (options.class.constructor === String) {
        this.classList.add(options.class);
      } else {
        this.classList.add(...options.class);
      }
    }

    if (options.text !== undefined) {
      this.text = options.text;
    }

    if (options.html !== undefined) {
      this.html = options.html;
    }

    if (options.style !== undefined) {
      this._element.style = options.style;
    }

    if (options.title !== undefined) {
      this._element.title = options.title;
    }

    if (options.backgroundColor !== undefined) {
      this._element.style.backgroundColor = options.backgroundColor;
    }

    if (options.color !== undefined) {
      this._element.style.color = options.color;
    }

    if (options.type !== undefined) {
      this._element.type = options.type;
    }

    if (options.children !== undefined) {
      for (const c of options.children) {
        this.appendChild(c);
      }
    }

    if (options.disabled !== undefined) {
      this._element.disabled = options.disabled;
    }

    if (options.tabIndex !== undefined) {
      this._element.tabindex = options.tabindex;
    }

    if (options.zIndex !== undefined) {
      this._element.style.zIndex = String(options.zIndex);
    }

    if (options.draggable !== undefined) {
      this.draggable = options.draggable;
    }

    if (options.onClick !== undefined) {
      this.addEventListener('click', options.onClick);
    }

    if (options.data !== undefined) {
      this.data = options.data;
    }

    if (options.tooltip !== undefined) {
      this.tooltip = options.tooltip;
    }
  }

  /**
   * @property {DOMElement?} element The HTML DOM element
   */
  get element() {
    return this._element;
  }

  /**
   * @property {Widget?} parent The parent widget of this widget.
   */
  get parent() {
    return this._parent;
  }

  set parent(p) {
    if (!p) {
      if (this._parent) {
        this._parent.removeChild(this);
        return;
      }
    } else {
      p.appendChild(this);
    }

    this.onResize();
  }

  get lastChild() {
    return this.children[this.children.length - 1];
  }

  /**
   * Insert a child widget before the given child widget.
   * @param {*} newChild
   * @param {*} refChild
   */
  insertBefore(newChild, refChild) {
    const index = this.children.indexOf(refChild);
    if (index === -1) {
      this.appendChild(newChild);
      return;
    }
    this.children.splice(index, 0, newChild);
    this._element.insertBefore(newChild._element, refChild._element);
  }

  /**
   * Insert a child widget after the given child widget.
   * @param {Widget} newChild 
   * @param {Widget} refChild 
   */
  insertAfter(newChild, refChild) {
    let index = this.children.indexOf(refChild);
    if (index === -1) {
      this.appendChild(newChild);
      return;
    }
    index++;
    if (index >= this.children.length) {
      this.appendChild(newChild);
      return;
    }
    const refWidget = this.children[index];
    this.children.splice(index, 0, newChild);
    this._element.insertBefore(newChild._element, refWidget._element);
  }

  /**
   * Add a child widget to this widget.
   * @param {Widget} child
   */
  appendChild(child) {
    if (child.parent === this) {
      return;
    }

    // Remove the widget from its current parent.
    if (child.parent) {
      child.parent.removeChild(child);
    }

    // Add the widget to the children list.
    child._parent = this;
    this.children.push(child);
    this._element.appendChild(child._element);

    const w = this.window;
    if (w) {
      child._addedToWindow(w);
    }

    child.onResize();
  }

  remove() {
    this.element.remove();
  }

  /**
   * Remove a child widget.
   * @param {Widget} child
   */
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index != -1) {
      this.children.splice(index, 1);
    }
    child._parent = null;
    this._element.removeChild(child._element);
  }

  /**
   * Remove all children from this widget.
   */
  removeAllChildren() {
    for (const child of this.children) {
      child._parent = null;
    }
    this.children.length = 0;
    while (this._element.firstChild) {
      this._element.removeChild(this._element.lastChild);
    }
  }

  /**
   * Get the position of the element on the page.
   * @return {Array}
   */
  getPagePosition() {
    let lx = 0;
    let ly = 0;
    for (let el = this._element; el != null; el = el.offsetParent) {
      lx += el.offsetLeft;
      ly += el.offsetTop;
    }
    return [lx, ly];
  }

  /**
   * Parse out the value from a CSS string
   * @param {*} cssValue
   */
  static getCssValue(cssValue) {
    if (!cssValue) {
      cssValue = '0px';
    }
    if (cssValue.endsWith('%')) {
      cssValue = cssValue.substring(0, cssValue.length - 1);
    } else {
      cssValue = cssValue.substring(0, cssValue.length - 2);
    }
    if (cssValue.includes('.')) {
      return parseFloat(cssValue);
    }
    return parseInt(cssValue);
  }

  /**
   * Return the size of a CSS property, like "padding", "Left", "Right"
   * @param {*} style
   * @param {*} property
   * @param {*} d1
   * @param {*} d2
   */
  static getStyleSize(style, property, d1, d2) {
    const s1 = Widget.getCssValue(style[`${property}${d1}`]);
    const s2 = Widget.getCssValue(style[`${property}${d2}`]);
    return s1 + s2;
  }

  /**
   * @property {number} width The width of the widget.
   */
  get width() {
    return this._element.offsetWidth;
  }

  /**
   * @property {number} height The height of the widget.
   */
  get height() {
    return this._element.offsetHeight;
  }

  /**
   * Get the bounding rect of the widget.
   * @return {DOMRect}
   */
  getBoundingClientRect() {
    return this._element.getBoundingClientRect();
  }

  /**
   * @property {bool} visible Is the element visible?
   */
  get visible() {
    let e = this;
    while (e) {
      if (e._element.style.display == 'none') {
        return false;
      }
      e = e.parent;
    }
    return true;
  }

  onDomChanged() {}

  domChanged() {
    this.onDomChanged();
    for (const c of this.children) {
      c.domChanged();
    }
  }

  /**
   * @property {number} left The x position of the element.
   */
  get left() {
    return this._element ? this._element.offsetLeft : 0;
  }

  /**
   * @property {number} top The y position of the element.
   */
  get top() {
    return this._element ? this._element.offsetTop : 0;
  }

  /**
   * Set the position of the element.
   */
  setPosition(x, y, type) {
    type = type || 'absolute';
    this._element.style.position = type;
    this._element.style.left = `${x}px`;
    this._element.style.top = `${y}px`;
  }

  /**
   * Resize the element.
   */
  resize(w, h) {
    // style.width/height is only for the inner contents of the widget,
    // not the full size of the widget including border and padding.
    // Since the resize function wants to encompass the entire widget,
    // we need to subtract the border and padding sizes from the size set
    // to the style.
    const rect = this.getBoundingClientRect();
    const dx = this._element.offsetWidth - rect.width;
    const dy = this._element.offsetHeight - rect.height;
    this._element.style.width = `${w - dx}px`;
    this._element.style.height = `${h - dy}px`;
  }

  onResize() {
    for (const c of this.children) {
      c.onResize();
    }
  }

  /**
   * @property {String} style The CSS style of the element.
   */
  get style() {
    return this._element.style;
  }

  set style(v) {
    this._element.style = v;
  }

  /**
   * @property {Array} classList The CSS class set of the element.
   */
  get classList() {
    return this._element.classList;
  }

  /**
   * @property {String} text The inner text of the element.
   */
  get text() {
    return this._element.innerText;
  }

  set text(s) {
    this._element.innerText = s;
  }

  get textContent() {
    return this._element.textContent;
  }

  set textContent(s) {
    this._element.textContent = s;
  }

  get html() {
    return this._element.innerHTML;
  }

  set html(v) {
    this._element.innerHTML = v;
  }

  get title() {
    return this._element.title;
  }

  set title(v) {
    this._element.title = v;
  }

  get tooltip() {
    return this._element.title;
  }

  set tooltip(v) {
    this._element.title = v;
  }

  get disabled() {
    return this._element.disabled;
  }

  set disabled(v) {
    this._element.disabled = v;
  }

  get dataset() {
    return this._element.dataset;
  }

  get tabIndex() {
    return this._element.tabindex;
  }

  set tabIndex(v) {
    this._element.tabIndex = v;
  }

  get zIndex() {
    return parseInt(this._element.style.zorder);
  }

  set zIndex(v) {
    this._element.style.zorder = String(v);
  }

  get draggable() {
    return this._element.draggable;
  }

  set draggable(v) {
    this._element.draggable = v;
    if (v) {
      this._dragStartEvent = this.dragStartEvent.bind(this);
      this._dragEndEvent = this.dragEndEvent.bind(this);
      this._dragEvent = this.dragEvent.bind(this);
      this.addEventListener('drag', this._dragEvent);
      this.addEventListener('dragstart', this._dragStartEvent);
      this.addEventListener('dragend', this._dragEndEvent);
    } else {
      if (this._dragEvent) {
        this.removeEventListener('drag', this._dragEvent);
        this.removeEventListener('dragstart', this._dragStartEvent);
        this.removeEventListener('dragend', this._dragEndEvent);
      }
    }
  }

  querySelector() {
    return this._element.querySelector(...arguments);
  }

  addEventListener() {
    return this._element.addEventListener(...arguments);
  }

  removeEventListener() {
    return this._element.removeEventListener(...arguments);
  }

  dispatchEvent() {
    return this._element.dispatchEvent(...arguments);
  }

  /**
   * Repaint the widget.
   * @param {bool} allDecendents
   */
  repaint(allDecendents = true) {
    if (this.paintEvent) this.paintEvent();
    if (allDecendents) {
      for (const c of this.children) {
        c.repaint(allDecendents);
      }
    }
  }

  _startResize() {
    if (this.startResize) {
      this.startResize();
    }
    for (const c of this.children) {
      c._startResize();
    }
  }

  _addedToWindow(w) {
    if (this.onAddedToWindow) {
      this.onAddedToWindow(w);
    }
    for (const c of this.children) {
      c._addedToWindow(w);
    }
  }

  get window() {
    return Widget.window;
  }

  /**
   * Start listening for mousePressEvent, mouseMoveEvent, and mouseReleaseEvent.
   */
  enableMouseEvents() {
    if (!this._mouseDownEnabled && this._element) {
      this._mouseDownEnabled = true;
      this._element.addEventListener('mousedown', this._onMouseDown.bind(this));
    }
    if (!this._mouseMoveEnabled && this._element) {
      this.__mouseMoveEnabled = true;
      this._element.addEventListener('mousemove', this._onMouseMove.bind(this));
    }
    if (!this._mouseUpEnabled && this._element) {
      this._mouseUpEnabled = true;
      this._element.addEventListener('mouseup', this._onMouseUp.bind(this));
    }
  }

  /**
   * Start listening for mouseMoveEvent.
   */
  enableMouseMoveEvent() {
    if (!this._mouseMoveEnabled && this._element) {
      this.__mouseMoveEnabled = true;
      this._element.addEventListener('mousemove', this._onMouseMove.bind(this));
    }
  }

  /**
   * Start listening for ContextMenu events.
   */
  enableContextMenuEvent() {
    this.enableMouseMoveEvent();
    if (!this._contextMenuEnabled && this._element) {
      this._contextMenuEnabled = true;
      this._element.addEventListener(
        'contextmenu',
        this._onContextMenu.bind(this)
      );
    }
  }

  /**
   * Start listenening for Click events.
   */
  enableClickEvent() {
    if (!this._clickEnabled && this._element) {
      this.__clickEnabled = true;
      this._element.addEventListener('click', this._onClick.bind(this));
    }
  }

  /**
   * Start listening for DoubleClick events.
   */
  enableDoubleClickEvent() {
    //this.enableMouseMoveEvent();
    if (!this._doubleClickEnabled && this._element) {
      this._doubleClickEnabled = true;
      this._element.addEventListener(
        'dblclick',
        this._onDoubleClick.bind(this)
      );
    }
  }

  /**
   * Start listening for MouseWheel events.
   */
  enableMouseWheelEvent() {
    if (!this._mouseWheelEnabled && this._element) {
      this._mouseWheelEnabled = true;
      this._element.addEventListener(
        'mousewheel',
        this._onMouseWheel.bind(this)
      );
    }
  }

  /**
   * Start listening for when the mouse enters the widget.
   */
  enableEnterEvent() {
    this.enableMouseMoveEvent();
    if (!this._mouseOverEnabled && this._element) {
      this._mouseOverEnabled = true;
      this._element.addEventListener('mouseover', this._onMouseOver.bind(this));
    }
  }

  /**
   * Start listening for when the mouse leaves the widget.
   */
  enableLeaveEvent() {
    this.enableMouseMoveEvent();
    if (!this._mouseOutEnabled && this._element) {
      this._mouseOutEnabled = true;
      this._element.addEventListener('mouseout', this._onMouseOut.bind(this));
    }
  }

  /**
   * Enable listening for touch events.
   */
  enableTouchEvents() {
    if (!this._touchEventsEnabled) {
      this._touchEventsEnabled = true;
      this._element.addEventListener(
        'touchstart',
        this._onTouchStart.bind(this)
      );
      this._element.addEventListener('touchend', this._onTouchEnd.bind(this));
      this._element.addEventListener(
        'touchcancel',
        this._onTouchCancel.bind(this)
      );
      this._element.addEventListener('touchmove', this._onTouchMove.bind(this));
      // Without this, Android Chrome will hijack touch events.
      this.style.touchAction = 'none';
    }
  }

  enablePointerEvents(bindToWindow) {
    if (!this._pointerEventsEnabled) {
      this._pointerEventsEnabled = true;
      this._element.addEventListener(
        'pointerdown',
        this._onPointerDown.bind(this)
      );
      if (bindToWindow) {
        window.addEventListener('pointermove', this._onPointerMove.bind(this));
        window.addEventListener('pointerup', this._onPointerUp.bind(this));
      } else {
        this._element.addEventListener(
          'pointermove',
          this._onPointerMove.bind(this)
        );
        this._element.addEventListener(
          'pointerup',
          this._onPointerUp.bind(this)
        );
      }
      // Without this, Android Chrome will hijack touch events.
      this.style.touchAction = 'none';
    }
  }

  _onPointerDown(e) {
    this.hasFocus = true;
    const pointer = new Pointer(e);
    if (Widget.currentPointers.some((p) => p.id === pointer.id)) return;
    Widget.currentPointers.push(pointer);
    //this.element.setPointerCapture(e.pointerId);
    const res = this.pointerDownEvent(e, Widget.currentPointers, pointer);
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  releasePointers() {
    //for (let p of Widget.currentPointers)
    //this.element.releasePointerCapture(p.id);
    Widget.currentPointers.length = 0;
  }

  _onPointerMove(e) {
    const pointer = new Pointer(e);

    const index = Widget.currentPointers.findIndex((p) => p.id === pointer.id);
    if (index !== -1) Widget.currentPointers[index] = pointer;

    this.hasFocus = true;
    const res = this.pointerMoveEvent(e, Widget.currentPointers, pointer);
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  _onPointerUp(e) {
    const pointer = new Pointer(e);
    //if (Widget.currentPointers.some((p) => p.id === pointer.id))
    //this.element.releasePointerCapture(e.pointerId);
    const index = Widget.currentPointers.findIndex((p) => p.id === pointer.id);
    if (index != -1) {
      Widget.currentPointers.splice(index, 1);
    }

    this.hasFocus = true;
    const res = this.pointerUpEvent(e, Widget.currentPointers, pointer);
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  pointerDownEvent() {
    return true;
  }

  pointerMoveEvent() {
    return true;
  }

  pointerUpEvent() {
    return true;
  }

  /**
   * Start listening for KeyPress events.
   */
  enableKeyPressEvent() {
    this.enableEnterEvent();
    this.enableLeaveEvent();
    this.enableMouseMoveEvent();
    if (!this._keyPressEnabled) {
      this._keyPressEnabled = true;
      // key events seem to only work on the document level. That's
      // why we enable enter/leave events, to filter the events to only
      // accept events for the widget if the mouse is over the widget.
      document.addEventListener('keydown', this._onKeyPress.bind(this));
      //this.element.addEventListener("keydown", this._onKeyPress.bind(this));
    }
  }

  /**
   * Start listening for KeyRelease events.
   */
  enableKeyReleaseEvent() {
    this.enableEnterEvent();
    this.enableLeaveEvent();
    this.enableMouseMoveEvent();
    if (!this._keyReleaseEnabled) {
      this._keyReleaseEnabled = true;
      // key events seem to only work on the document level. That's
      // why we enable enter/leave events, to filter the events to only
      // accept events for the widget if the mouse is over the widget.
      document.addEventListener('keyup', this._onKeyRelease.bind(this));
      //this.element.addEventListener("keyup", this._onKeyRelease.bind(this));
    }
  }

  /**
   * Event called when the widget is to be drawn
   */
  //paintEvent() { }

  /**
   * Event called when a mouse button is pressed on the wdiget.
   */
  mousePressEvent() {
    return false;
  }

  /**
   * Event called when the mouse is moved over the widget.
   * @param {*} e
   */
  mouseMoveEvent(e) {
    //this.updatePositionFromEvent(e);
    return false;
  }

  /**
   * Event called when a mouse button is released over the widget.
   */
  mouseReleaseEvent() {
    return false;
  }

  /**
   * Event called when the widget recieves a ContextMenu event, usually from
   * the right mouse button.
   */
  contextMenuEvent() {
    return true;
  }

  /**
   * Event called when a mouse button is clicked.
   */
  clickEvent() {
    return true;
  }

  /**
   * Event called when a mouse button is double clicked.
   */
  doubleClickEvent() {
    return true;
  }

  /**
   * Event called when a mouse wheel is scrolled.
   */
  mouseWheelEvent() {
    return true;
  }

  /**
   * Event called when the mouse enters the widget.
   */
  enterEvent() {
    return true;
  }

  /**
   * Event called when the mouse leaves the widget.
   */
  leaveEvent() {
    return true;
  }

  /**
   * Event called when a key is pressed on the widget.
   */
  keyPressEvent() {
    return true;
  }

  /**
   * Event called when a key is released on the widget.
   */
  keyReleaseEvent() {
    return true;
  }

  /**
   * Event called when a touch has started.
   */
  touchStartEvent() {}

  /**
   * Event called when a touch has ended.
   */
  touchEndEvent() {}

  /**
   * Event called when a touch has been canceled.
   */
  touchCancelEvent() {}

  /**
   * Event called when a touch has moved.
   */
  touchMoveEvent() {}

  /**
   * Event called when the element starts dragging.
   */
  dragStartEvent() {}

  /**
   * Event called when the element ends dragging.
   */
  dragEndEvent() {}

  /**
   * Event called when the element is dragging.
   */
  dragEvent() {}

  /**
   * Called to update the current tracked mouse position on the widget.
   * @param {Event} e
   */
  updatePositionFromEvent(e) {
    if (!this._element) {
      return;
    }

    if (this.startMouseEvent) {
      e.targetX = Math.max(
        0,
        Math.min(
          this.element.clientWidth,
          this.startMouseX + e.pageX - this.startMouseEvent.pageX
        )
      );

      e.targetY = Math.max(
        0,
        Math.min(
          this.element.clientHeight,
          this.startMouseY + e.pageY - this.startMouseEvent.pageY
        )
      );
    } else {
      e.targetX = e.offsetX;
      e.targetY = e.offsetY;
    }

    this.mouseX = e.offsetX;
    this.mouseY = e.offsetY;
    this.mousePageX = e.clientX;
    this.mousePageY = e.clientY;

    if (e.movementX === undefined) {
      e.movementX = e.clientX - this.lastMouseX;
      e.movementY = e.clientY - this.lastMouseY;
    }

    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
  }

  /**
   * Event called when the mouse is pressed on the widget.
   * @param {Event} e
   */
  _onMouseDown(e) {
    this.startMouseEvent = e;
    this.startMouseX = e.offsetX;
    this.startMouseY = e.offsetY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    //this.updatePositionFromEvent(e);
    this._isMouseDown = true;
    this.mouseButton = e.button;
    const res = this.mousePressEvent(e);
    // If true is returned, prevent the event from propagating up and capture the mouse.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
      //this.beginMouseCapture();
    }
    return res;
  }

  /**
   * Event called when the mouse moves on the widget.
   * @param {Event} e
   */
  _onMouseMove(e) {
    //this.updatePositionFromEvent(e);
    return this.mouseMoveEvent(e);
  }

  /**
   * Event called when the mosue is released on the widget.
   * @param {Event} e
   */
  _onMouseUp(e) {
    //this.updatePositionFromEvent(e);
    this.startMouseEvent = null;
    if (!this._isMouseDown) {
      return true;
    }

    this._isMouseDown = false;
    const res = this.mouseReleaseEvent(e);

    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }

    //this.endMouseCapture();
    return res;
  }

  /**
   * Called for a ContextMenu event.
   * @param {Event} e
   */
  _onContextMenu(e) {
    const res = this.contextMenuEvent(e);
    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
    return false;
  }

  /**
   * Called fora  Click event.
   * @param {Event} e
   */
  _onClick(e) {
    const res = this.clickEvent(e);
    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a DoubleClick event.
   * @param {Event} e
   */
  _onDoubleClick(e) {
    const res = this.doubleClickEvent(e);
    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for mouseWheel event.
   * @param {Event} e
   */
  _onMouseWheel(e) {
    if (e.type === 'wheel') {
      e.wheel = -e.deltaY;
    } else {
      // in firefox deltaY is 1 while in Chrome is 120
      e.wheel = e.wheelDeltaY != null ? e.wheelDeltaY : e.detail * -60;
    }

    // from stack overflow
    // firefox doesnt have wheelDelta
    e.delta =
      e.wheelDelta !== undefined
        ? e.wheelDelta / 40
        : e.deltaY
        ? -e.deltaY / 3
        : 0;

    const res = this.mouseWheelEvent(e);

    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a MouseOver event.
   * @param {Event} e
   */
  _onMouseOver(e) {
    this.hasFocus = true;
    const res = this.enterEvent(e);
    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a MouseOut event.
   * @param {Event} e
   */
  _onMouseOut(e) {
    this.hasFocus = false;
    const res = this.leaveEvent(e);
    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a KeyPress event.
   * @param {Event} e
   */
  _onKeyPress(e) {
    if (!this.hasFocus) {
      return;
    }
    const res = this.keyPressEvent(e);
    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a KeyRelease event.
   * @param {Event} e
   */
  _onKeyRelease(e) {
    if (!this.hasFocus) {
      return;
    }
    const res = this.keyReleaseEvent(e);
    // if false is returned, prevent the event from propagating up.
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a touchstart event.
   * @param {Event} e
   */
  _onTouchStart(e) {
    this.hasFocus = true;
    const res = this.touchStartEvent(e);
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a touchend event.
   * @param {Event} e
   */
  _onTouchEnd(e) {
    this.hasFocus = true;
    const res = this.touchEndEvent(e);
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a touchcancel event.
   * @param {Event} e
   */
  _onTouchCancel(e) {
    this.hasFocus = true;
    const res = this.touchCancelEvent(e);
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  /**
   * Called for a touchmove event.
   * @param {Event} e
   */
  _onTouchMove(e) {
    this.hasFocus = true;
    const res = this.touchMoveEvent(e);
    if (!res) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  trigger(eventName, params) {
    const event = new CustomEvent(eventName, {
      bubbles: true,
      cancelable: true,
      detail: params,
    });

    if (this.dispatchEvent) {
      this.dispatchEvent(event);
    }

    return event;
  }

  disableDropEvents() {
    if (!this._onDragEvent) {
      return;
    }

    this.removeEventListener('dragenter', this._onDragEvent);
    this.removeEventListener('drop', this._onDropEvent);
    this.addEventListener('dragleave', this._onDragEvent);
    this.addEventListener('dragover', this._onDragEvent);
    this.addEventListener('drop', this._onDropEvent);

    this._onDragEvent = null;
    this._onDropEvent = null;
  }

  enableDropEvents() {
    if (this._onDragEvent) {
      return;
    }

    this._onDragEvent = this.onDragEvent.bind(this);
    this._onDropEvent = this.onDropEvent.bind(this);

    this.addEventListener('dragenter', this._onDragEvent);
  }

  onDragEvent(event) {
    const element = this.element;

    if (event.type == 'dragenter') {
      element.addEventListener('dragleave', this._onDragEvent);
      element.addEventListener('dragover', this._onDragEvent);
      element.addEventListener('drop', this._onDropEvent);
    }
    if (event.type == 'dragenter' && this.dragEnterEvent) {
      this.dragEnterEvent(event);
    }
    if (event.type == 'dragleave' && this.dragLeaveEvent) {
      this.dragLeaveEvent(event);
    }
    if (event.type == 'dragover' && this.dragOverEvent) {
      this.dragOverEvent(event);
    }
  }

  onDropEvent(event) {
    this.removeEventListener('dragleave', this._onDragEvent);
    this.removeEventListener('dragover', this._onDragEvent);
    this.removeEventListener('drop', this._onDropEvent);

    if (this.dropEvent) {
      this.dropEvent(event);
    }
  }
}

Widget.window = null;
Widget.currentPointers = [];
Widget.disablePaintingOnResize = false;
Widget.id = 0;
