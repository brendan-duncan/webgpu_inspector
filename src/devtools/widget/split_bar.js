import { Div } from './div.js';
import { Widget } from './widget.js';

/**
 * A draggable bar to adjust sizes of elements in a splitter.
 */
export class SplitBar extends Div {
  constructor(orientation, parent, options) {
    super(parent, options);

    this.orientation = orientation;
    this._mousePressed = false;
    this._mouseX = 0;
    this._mouseY = 0;
    this._prevWidget = null;
    this._nextWidget = null;
    this._splitIndex = 0;

    this._element.classList.add('splitbar');

    if (this.orientation == SplitBar.Horizontal) {
      this._element.style.height = `${SplitBar.size}px`;
      this._element.style.width = '100%';
      this._element.style.cursor = 'n-resize';
    } else {
      this._element.style.width = `${SplitBar.size}px`;
      this._element.style.height = '100%';
      this._element.style.cursor = 'e-resize';
    }

    this.enablePointerEvents();
  }

  pointerDownEvent(e) {
    this._mousePressed = true;
    this._mouseX = e.clientX;
    this._mouseY = e.clientY;
    for (let i = 0; i < this.parent.children.length; ++i) {
      let w = this.parent.children[i];
      if (w === this) {
        this._splitIndex = i;
        this._prevWidget = this.parent.children[i - 1];
        this._nextWidget = this.parent.children[i + 1];
        break;
      }
    }
    if (this._prevWidget) {
      this._prevWidget._startResize();
    }
    if (this._nextWidget) {
      this._nextWidget._startResize();
    }

    this.element.setPointerCapture(e.pointerId);
  }

  pointerMoveEvent(e) {
    if (!this._mousePressed) {
      return;
    }

    if (this.orientation === SplitBar.Horizontal) {
      const dy = e.clientY - this._mouseY;
      if (dy != 0) {
        if (this.parent.mode === SplitBar.Percentage) {
          const pct = dy / this.parent.height;
          this.parent.position += pct;
        } else {
          this.parent.position += dy;
        }
      }
    } else {
      const dx = e.clientX - this._mouseX;
      if (dx != 0) {
        if (this.parent.mode === SplitBar.Percentage) {
          const pct = dx / this.parent.width;
          this.parent.position += pct;
        } else {
          this.parent.position += dx;
        }
      }
    }

    this._mouseX = e.clientX;
    this._mouseY = e.clientY;

    return false;
  }

  pointerUpEvent() {
    this._prevWidget = null;
    this._nextWidget = null;
    this._mousePressed = false;
    Widget.disablePaintingOnResize = false;
    for (let w of this.parent.children) {
      w.repaint(true);
    }
    return false;
  }
}

SplitBar.isSplitBar = true;
SplitBar.Horizontal = 0;
SplitBar.Vertical = 1;
SplitBar.size = 6;
