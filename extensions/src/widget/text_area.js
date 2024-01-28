import { Widget } from './widget.js';
import { Signal } from './signal.js';

export class TextArea extends Widget {
  constructor(parent, options) {
    super('textArea', parent, options);
    this.classList.add('text-area');

    this.onChange = new Signal();
    this.onEdit = new Signal();

    const self = this;
    this.element.addEventListener('change', function () {
      let v = self.value;
      self.onChange.emit(v);
      if (self._onChange) {
        self._onChange(v);
      }
    });

    this.element.addEventListener('input', function () {
      let v = self.value;
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

    if (options.value) {
      this.value = options.value;
    }

    if (options.placeholder) {
      this.placeholder = options.placeholder;
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

  get value() {
    return this._element.value;
  }

  set value(t) {
    this._element.value = t;
  }

  get placeholder() {
    return this._element.placeholder;
  }

  set placeholder(v) {
    this._element.placeholder = v;
  }

  get readOnly() {
    return this._element.readOnly;
  }

  set readOnly(v) {
    this._element.readOnly = v;
  }
}
