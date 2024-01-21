import { Split } from './split.js';

/**
 * The children of this widget are arranged vertically and separated by a draggable SplitBar.
 */
export class VSplit extends Split {
  constructor(parent, options) {
    options = options || {};
    options.direction = Split.Vertical;
    super(parent, options);
  }
}
