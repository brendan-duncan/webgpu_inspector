import { Widget } from './widget.js';

/**
 * A SPAN element widget.
 */
export class Span extends Widget {
  constructor(parent, options) {
    super('span', parent, options);
  }
}

Span._idPrefix = 'SPAN';
