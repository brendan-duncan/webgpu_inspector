import { Div } from './div.js';
import { SplitBar } from './split_bar.js';

/**
 * The children of this widget are arranged horizontally or vertically and separated by a
 * draggable SplitBar.
 */
export class Split extends Div {
  constructor(parent, options) {
    super(parent);
    this.classList.add('split', 'disable-selection');

    this._direction = Split.Horizontal;
    this._position = 0.5;
    this.mode = Split.Percentage;

    if (options) {
      this.configure(options);
    }

    if (this._direction === Split.Horizontal) {
      this.classList.add('hsplit');
    } else {
      this.classList.add('vsplit');
    }
  }

  configure(options) {
    if (options.direction !== undefined) {
      this._direction = options.direction;
    }

    super.configure(options);

    if (options.position !== undefined) {
      this.position = options.position;
      if (this.position > 1) {
        this.mode = Split.Pixel;
      }
    }
  }

  get direction() {
    return this._direction;
  }

  get position() {
    return this._position;
  }

  set position(pos) {
    this._position = pos;
    this.updatePosition();
  }

  updatePosition() {
    if (this.children.length < 3) {
      return;
    }

    const numSplitBars = this.children.length - 2;
    const splitBarSize = numSplitBars * SplitBar.size;

    let splitPos;
    let splitPos2;
    if (this._position < 1) {
      const pct = this._position * 100;
      splitPos = `${pct}%`;
      splitPos2 = `calc(${100 - pct}% - ${splitBarSize}px)`;
    } else {
      splitPos = `${this._position}px`;
      splitPos2 = `calc(100% - ${this._position}px - ${splitBarSize}px)`;
    }

    if (this._direction == Split.Horizontal) {
      this.children[0].style.width = splitPos;
      this.children[0].element.width = '0';

      this.children[2].style.width = splitPos2;
      this.children[2].element.width = '0';
    } else {
      this.children[0].element.height = '0';
      this.children[0].style.height = splitPos;

      this.children[2].style.height = splitPos2;
      this.children[2].element.height = '0';
    }

    this.onResize();
  }

  appendChild(child) {
    if (this.direction == Split.Horizontal)
      child.style.display = 'inline-block';

    if (this.children.length == 0 || child.constructor.isSplitBar) {
      if (this.children.length == 0) {
        child.style.width = '100%';
        child.style.height = '100%';
      } else {
        if (this._direction == Split.Horizontal) {
          child.style.height = '100%';
        } else {
          child.style.width = '100%';
        }
      }
      super.appendChild(child);
      return;
    }

    const percent = (1 / (this.children.length + 1)) * 100;

    new SplitBar(
      this._direction == Split.Horizontal
        ? SplitBar.Vertical
        : SplitBar.Horizontal,
      this
    );

    super.appendChild(child);

    const numSplitBars = this.children.length - 2;
    const splitBarSize = numSplitBars * SplitBar.size;

    for (const c of this.children) {
      if (!c.constructor.isSplitBar) {
        if (c === this.children[this.children.length - 1]) {
          if (this._direction == Split.Horizontal) {
            c.element.width = '0';
            c.style.height = '100%';
            c.style.width = `calc(${100 - percent}% - ${splitBarSize}px)`;
          } else {
            c.element.height = '0';
            c.style.width = '100%';
            c.style.height = `calc(${100 - percent}% - ${splitBarSize}px)`;
          }
        } else {
          if (this._direction == Split.Horizontal) {
            c.style.width = `${percent}%`;
          } else {
            c.style.height = `${percent}%`;
          }
        }
      }

      c.onResize();
    }

    if (this._position != 0.5) {
      this.updatePosition();
    }
  }
}

Split.Horizontal = 0;
Split.Vertical = 1;
Split.Percentage = 0;
Split.Pixel = 1;
