import { Input } from './input.js';
import { Label } from './label.js';
import { Span } from './span.js';

export class Checkbox extends Span {
  constructor(parent, options) {
    super(parent, options);
    this.classList.add('styled-checkbox-container');

    this.input = new Input(this, options);
    this.input.type = 'checkbox';
    this.input.classList.add('styled-checkbox');

    if (!this.label) {
      this.label = new Label('', this, { for: this });
    }
  }

  get checked() {
    return this.input.checked;
  }

  set checked(v) {
    this.input.checked = v;
  }

  get label() {
    return this.input.label;
  }

  set label(v) {
    this.input.label = v;
  }

  get indeterminate() {
    return this.input.indeterminate;
  }

  set indeterminate(v) {
    this.input.indeterminate = v;
  }
}
