import { Div } from './div.js';

/**
 * A single content area with multiple panels, each associated with a header in a list.
 */
export class TabPage extends Div {
  constructor(panel, parent, options) {
    super(parent, options);
    this.classList.add('tab-page');
    this.style.display = 'none';
    this.panel = panel;
    if (panel) {
      panel.parent = this;
      //panel.style.width = '100%';
    }
  }
}

TabPage._idPrefix = 'TABPAGE';
TabPage.isTabPage = true;
