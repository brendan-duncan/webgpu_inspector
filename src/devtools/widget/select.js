import { Widget } from './widget.js';
import { Label } from './label.js';
import { TextInput } from './text_input.js';
import { Signal } from '../../utils/signal.js';

export class Select extends Widget {
  constructor(parent, options) {
    super('span', parent);
    this.classList.add('select');

    this.select = new Widget('select', this);
    this.select.style.width = '100%';
    this.select.style.height = '20px';
    this.select.style.border = 'none';
    this.select.style.display = 'inline-block';
    this.select.classList.add('select');
    this.onChange = new Signal();

    const self = this;
    this.select.element.addEventListener('change', function () {
      if (self.selectEdit) {
        self.selectEdit.value = self.select.element.value;
      } else {
        self.onChange.emit(self.value);
        if (self._onChange) {
          self._onChange(self.value);
        }
      }
    });

    if (options && options.editable) {
      this.selectEdit = new TextInput(this, {
        value: options.options[0],
        style:
          'position: absolute; top: 2px; left: 0px; width: calc(100% - 20px); height: 20px; border: none;',
      });
      this.selectEdit.onChange.addListener(function () {
        self.onChange.emit(self.value);
        if (self._onChange) {
          self._onChange(self.value);
        }
      });
    }

    if (options) {
      this.configure(options);
    }

    this.style.height = '20px';
    this.style.position = 'relative';
    this.style.minWidth = '50px';
  }

  get disabled() {
    return super.disabled;
  }

  set disabled(v) {
    super.disabled = v;
    this.select.disabled = v;
    if (this.selectEdit) {
      this.selectEdit.disabled = v;
    }
  }

  configure(options) {
    if (!options) {
      return;
    }
    super.configure(options);

    if (options.options) {
      for (const o of options.options) {
        this.addOption(o);
      }
    }

    if (options.label !== undefined) {
      if (options.label.constructor === String) {
        this.label = new Label(options.label, this.parent, {
          fixedSize: 0,
          for: this,
        });
      } else {
        this.label = options.label;
        this.label.for = this.id;
        if (!this.label.parent) {
          this.label.parent = this.parent;
        }
      }
    }

    if (options.value !== undefined) {
      this.select.element.value = options.value;
    }

    if (options.index !== undefined) {
      this.select.element.selectedIndex = options.index;
      if (this.selectEdit) {
        this.selectEdit.value = this.select.element.value;
      }
    }

    if (options.onChange !== undefined) {
      this._onChange = options.onChange;
    }
  }

  get index() {
    return this.select.element.selectedIndex;
  }

  set index(v) {
    this.select.element.seelectedIndex = v;
  }

  get value() {
    if (this.selectEdit) {
      return this.selectEdit.value;
    }
    return this.select.element.value;
  }

  set value(v) {
    if (this.selectEdit) {
      this.selectEdit.value = v;
    } else {
      this.select.element.value = v;
    }
  }

  addOption(text) {
    const o = document.createElement('option');
    o.innerText = text;
    this.select.element.add(o);
  }

  resize(width, height) {
    if (!this._element) {
      return;
    }

    // SELECT elements behave differently than other elements with resizing.
    this.select.element.style.width = `${width}px`;
    this.select.element.style.height = `${height}px`;

    this.onResize();

    if (!Widget.disablePaintingOnResize) {
      this.paintEvent();
    }
  }
}
