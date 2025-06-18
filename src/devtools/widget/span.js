import { Widget } from './widget.js';

/**
 * A SPAN element widget.
 */
export class Span extends Widget {
  constructor(parent, options) {
    super('span', parent, options);
    if (options?.text && !options?.tooltip) {
      this.tooltip = options.text;
    }
  }
}

Span._idPrefix = 'SPAN';
