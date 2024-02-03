import { Widget } from './widget.js';
import { Label } from './label.js';
import { Signal } from '../../utils/signal.js';

export class Input extends Widget {
  constructor(parent, options) {
    super('input', parent, options);
    this.onChange = new Signal();
    this.onEdit = new Signal();
    const self = this;

    this.element.addEventListener('change', function () {
      let v = self.type === 'checkbox' ? self.checked : self.value;
      self.onChange.emit(v);
      if (self._onChange) {
        self._onChange(v);
      }
    });

    this.element.addEventListener('input', function () {
      let v = self.type === 'checkbox' ? self.checked : self.value;
      self.onEdit.emit(v);
      if (self._onEdit) {
        self._onEdit(v);
      }
    });
  }

  configure(options) {
    if (!options) {
      return;
    }
    super.configure(options);

    if (options.type !== undefined) {
      this.type = options.type;
    }

    if (options.checked !== undefined) {
      this.checked = options.checked;
    }

    if (options.value !== undefined) {
      this.value = options.value;
    }

    if (options.label !== undefined) {
      if (options.label.constructor === String) {
        this.label = new Label(options.label, this.parent, {
          for: this,
        });
      } else {
        this.label = options.label;
        this.label.for = this.id;
      }
    }

    if (options.readOnly !== undefined) {
      this.readOnly = options.readOnly;
    }

    if (options.onChange !== undefined) {
      this._onChange = options.onChange;
    }

    if (options.onEdit !== undefined) {
      this._onEdit = options.onEdit;
    }
  }

  get type() {
    return this._element.type;
  }

  set type(v) {
    this._element.type = v;
  }

  get checked() {
    return this._element.checked;
  }

  set checked(v) {
    this._element.checked = v;
  }

  get indeterminate() {
    return this._element.indeterminate;
  }

  set indeterminate(v) {
    this._element.indeterminate = v;
  }

  get value() {
    return this._element.value;
  }

  set value(v) {
    this._element.value = v;
  }

  get readOnly() {
    return this._element.readOnly;
  }

  set readOnly(v) {
    this._element.readOnly = v;
  }

  focus() {
    this._element.focus();
  }

  blur() {
    this._element.blur();
  }

  select() {
    this._element.select();
  }
}
