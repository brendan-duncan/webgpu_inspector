import { Span } from './span.js';
import { TextInput } from './text_input.js';

export class NumberInput extends Span {
  constructor(parent, options) {
    super(parent, options);
    this.classList.add('dragger');

    options = options || {};

    let isExpr = false;

    let value = options.value;
    if (value === null || value === undefined) {
      value = 0;
    } else if (value.constructor === String) {
      isExpr = isNaN(value);
      if (!isExpr) {
        value = parseFloat(value);
      }
    } else if (value.constructor !== Number) {
      value = 0;
    }

    const precision = options.precision != undefined ? options.precision : 3;

    this.value = value;
    this.precision = precision;
    this.units = options.units ?? "";
    this.disabled = !!options.disabled;
    this.horizontal = !!options.horizontal;
    this.linear = !!options.linear;
    this.step = options.step ?? 1;
    this.min = options.min ?? null;
    this.max = options.max ?? null;
    const container = new Span(this, { class: 'inputfield' });

    if (options.full) {
      container.classList.add('full');
    }

    if (this.disabled) {
      container.classList.add('disabled');
    }

    const inputClass = options.inputClass || 'full';
    const input = new TextInput(container, {
      class: ['text', 'number', inputClass],
      value: isExpr
        ? value
        : value.toFixed(precision) + (options.units ? options.units : ''),
      onChange: options.onChange,
    });
    this.input = input;
    input.ownerDocument = document;

    if (this.disabled) {
      input.disabled = true;
    }

    if (options.tabIndex) {
      input.tabIndex = options.tabIndex;
    }

    input.addEventListener('keydown', function (e) {
      if (e.keyCode == 38) {
        innerInc(1, e);
      } else if (e.keyCode == 40) {
        innerInc(-1, e);
      } else {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      return true;
    });

    const dragger = new Span(container, { class: 'drag_widget' });
    if (this.disabled) {
      dragger.classList.add('disabled');
    }

    this.dragger = dragger;

    dragger.addEventListener('mousedown', innerDown);
    input.addEventListener('wheel', innerWheel, false);
    input.addEventListener('mousewheel', innerWheel, false);

    let docBinded = null;

    const self = this;

    function innerDown(e) {
      if (isExpr) {
        return;
      }
      docBinded = input.ownerDocument;

      docBinded.removeEventListener('mousemove', innerMove);
      docBinded.removeEventListener('mouseup', innerUp);

      if (!self.disabled) {
        if (self.element.requestPointerLock) {
          self.element.requestPointerLock();
        }
        docBinded.addEventListener('mousemove', innerMove);
        docBinded.addEventListener('mouseup', innerUp);

        dragger.data = [e.screenX, e.screenY];

        self.trigger('startDragging');
      }

      e.stopPropagation();
      e.preventDefault();
    }

    function innerMove(e) {
      if (isExpr) {
        return;
      }
      const deltax = e.screenX - dragger.data[0];
      const deltay = dragger.data[1] - e.screenY;
      let diff = [deltax, deltay];
      if (e.movementX !== undefined) {
        diff = [e.movementX, -e.movementY];
      }

      dragger.data = [e.screenX, e.screenY];
      const axis = self.horizontal ? 0 : 1;

      innerInc(diff[axis], e);

      e.stopPropagation();
      e.preventDefault();
      return false;
    }

    function innerWheel(e) {
      if (isExpr) {
        return;
      }
      if (document.activeElement !== this) {
        return;
      }
      const delta =
        e.wheelDelta !== undefined
          ? e.wheelDelta
          : e.deltaY
          ? -e.deltaY / 3
          : 0;
      innerInc(delta > 0 ? 1 : -1, e);
      e.stopPropagation();
      e.preventDefault();
    }

    function innerUp(e) {
      if (isExpr) {
        return;
      }
      self.trigger('stopDragging');
      const doc = docBinded || document;
      docBinded = null;
      doc.removeEventListener('mousemove', innerMove);
      doc.removeEventListener('mouseup', innerUp);
      if (doc.exitPointerLock) {
        doc.exitPointerLock();
      }
      dragger.trigger('blur');
      e.stopPropagation();
      e.preventDefault();
      return false;
    }

    function innerInc(v, e) {
      if (isExpr) {
        return;
      }
      if (!self.linear) {
        v = v > 0 ? Math.pow(v, 1.2) : Math.pow(Math.abs(v), 1.2) * -1;
      }

      let scale = self.step ? self.step : 1.0;
      if (e && e.shiftKey) {
        scale *= 10;
      } else if (e && e.ctrlKey) {
        scale *= 0.1;
      }

      let value = parseFloat(input.value) + v * scale;

      if (self.max !== null && value > self.max) {
        value = self.max;
      }

      if (self.min !== null && value < self.min) {
        value = self.min;
      }

      value = value.toFixed(self.precision);
      if (self.units) {
        value += self.units;
      }
      input.value = value;

      input.trigger('change');
    }
  }

  setRange(min, max) {
    this.min = min;
    this.max = max;
  }

  setValue(v, skipEvent) {
    const isExpr = isNaN(v);
    if (!isExpr) {
      v = parseFloat(v);
      if (this.min !== null && v < this.min) {
        v = this.min;
      }
      if (this.max !== null && v > this.max) {
        v = this.max;
      }
    }
    if (this.value == v) {
      return;
    }
    this.value = v;
    if (!isExpr) {
      if (this.precision) {
        v = v.toFixed(this.precision);
      }
      if (this.units) {
        v += this.units;
      }
    }
    if (this.input.value != v) {
      this.input.value = v;
      if (!skipEvent) {
        this.input.onChange.emit(v);
      }
    }
  }

  getValue() {
    return this.value;
  }
}
