import { Input } from './input.js';

export class TextInput extends Input {
  constructor(parent, options) {
    super(parent, options);
    this.classList.add('text-input');
    this.type = 'text';

    this.enableKeyPressEvent();
  }

  configure(options) {
    if (!options) return;
    super.configure(options);
    if (options.placeholder) this.placeholder = options.placeholder;
  }

  get placeholder() {
    return this.element.placeholder;
  }

  set placeholder(v) {
    this.element.placeholder = v;
  }

  keyPressEvent(e) {
    if (e.keyCode === 27)
      // Escape
      e.target.blur();
    return true;
  }
}
