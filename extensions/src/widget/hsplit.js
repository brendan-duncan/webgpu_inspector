import { Split } from './split.js';

/**
 * The children of this widget are arranged horizontally and separated by a draggable SplitBar.
 */
export class HSplit extends Split {
  constructor(parent, options) {
    options = options || {};
    options.direction = Split.Horizontal;
    super(parent, options);
  }
}
