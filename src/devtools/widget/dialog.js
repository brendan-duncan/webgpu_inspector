import { Div } from './div.js';
import { Button } from './button.js';
import { Span } from './span.js';
import { Window } from './window.js';

/**
 * Base class for modal windows. A modal window takes over the main window while it is active.
 */
export class Dialog extends Div {
  constructor(options) {
    const title = options?.title ?? 'Dialog';

    super({ class: options?.windowClass ?? 'dialog', title: title });

    if (options?.width) {
      this.style.width = `${options.width}px`;
    }

    const background =
      options?.parent ?? new Div({ class: 'dialog-background' });

    this.parent = background;

    const header = new Div(this, { class: 'dialog-header', title });

    if (!options?.noCloseButton) {
      const closeButton = new Button(header, {
        class: 'dialog-close-button',
        text: 'x',
        title: 'Close',
      });

      closeButton.addEventListener('mouseup', function (e) {
        if (e.target === closeButton.element) {
          Window.window.overlay = null;
        }
      });
    }

    this.title = new Span(header, { class: 'dialog-title', text: title });

    this.body = new Div(this, { class: 'dialog-body' });

    if (options?.body) {
      this.body.appendChild(options.body);
    }

    if (!options?.parent) {
      Window.window.overlay = background;
    }

    if (options?.draggable) {
      let isDragging = false;
      const rect = this.getBoundingClientRect();
      let x = rect ? rect.left : 0;
      let y = rect ? rect.top : 0;
      this.style.position = 'absolute';
      this.style.left = `${x}px`;
      this.style.top = `${y}px`;

      let prevX = 0;
      let prevY = 0;
      header.addEventListener('mousedown', function (e) {
        isDragging = true;
        prevX = e.clientX;
        prevY = e.clientY;
      });

      const self = this;
      document.addEventListener('mousemove', function (e) {
        if (!isDragging) {
          return;
        }
        const dx = e.clientX - prevX;
        const dy = e.clientY - prevY;
        x += dx;
        y += dy;
        prevX = e.clientX;
        prevY = e.clientY;
        self.style.left = `${x}px`;
        self.style.top = `${y}px`;
      });

      document.addEventListener('mouseup', function () {
        isDragging = false;
      });
    }
  }

  close() {
    Window.window.overlay = null;
  }
}
