import { Widget } from './widget.js';

/**
 * A generic DIV element, usually used as a container for other widgets.
 */
export class Div extends Widget {
  constructor(parent, options) {
    super('div', parent, options);
  }
}

Div._idPrefix = 'DIV';
