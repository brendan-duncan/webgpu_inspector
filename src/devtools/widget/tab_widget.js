import { Div } from './div.js';
import { TabHandle } from './tab_handle.js';
import { TabPage } from './tab_page.js';

/**
 * A TabWidget has multiple children widgets, only one of which is visible at a time. Selecting
 * the active child is done via a header of tab handles.
 */
export class TabWidget extends Div {
  constructor(parent, options) {
    super(parent);

    this._activeTab = -1;
    this.displayCloseButton = false;

    this._element.classList.add('tab-widget');

    this.headerElement = new Div(this);
    this.headerElement.classList.add('tab-header');

    this.iconsElement = new Div(this.headerElement);
    this.iconsElement.classList.add('tab-icons');

    this.tabListElement = new Div(this.headerElement);
    this.tabListElement.classList.add('tab-handle-list-container');

    this.contentElement = new Div(this);
    this.contentElement.classList.add('tab-content');
    this.contentElement.style.height = `calc(100% - ${this.headerElement.height}px)`;

    if (options) {
      this.configure(options);
    }
  }

  configure(options) {
    super.configure(options);

    if (options.displayCloseButton !== undefined) {
      this.displayCloseButton = options.displayCloseButton;
    }

    if (options.tabs !== undefined) {
      for (const tab of options.tabs) {
        this.addTab(tab.label, tab.contents);
      }
    }
  }

  /**
   * Remove all of the icons.
   */
  clearIcons() {
    this.iconsElement.children.length = 0;
  }

  /**
   * Add a tab.
   * @param {String} label
   * @param {Widget} panel
   */
  addTab(label, panel) {
    panel._tabLabel = label;
    const page = new TabPage(panel, this.contentElement);
    const handle = new TabHandle(label, page, this, this.tabListElement, {
      displayCloseButton: this.displayCloseButton,
    });

    if (this.tabListElement.children.length == 1) {
      this._activeTab = 0;
      handle.isActive = true;
      if (page) {
        page.repaint(true);
      }
    }

    panel.domChanged();
  }

  /**
   * Close a tab.
   * @param {TabHandle} handle
   */
  closeTabHandle(handle) {
    const index = this.tabListElement.children.indexOf(handle);
    if (index == -1) {
      return;
    }

    const page = this.contentElement.children[index];
    /*if (page) {
      page.children[0].close();
    }*/

    this.tabListElement.removeChild(handle);
    this.contentElement.removeChild(page);

    if (this._activeTab == index) {
      this._activeTab = -1;
    }

    if (this._activeTab == -1 && this.numTabs > 0) {
      this.activeTab = 0;
    }
  }

  /**
   * @property {number} numTabs Return the number of tabs.
   */
  get numTabs() {
    return this.tabListElement.children.length;
  }

  /**
   * @property {number} activeTab Get the index of the active tab.
   */
  get activeTab() {
    return this._activeTab;
  }

  /**
   * Set the current active tab.
   */
  set activeTab(index) {
    if (index < 0 || index > this.tabListElement.children.length) {
      return;
    }

    for (let i = 0, l = this.tabListElement.children.length; i < l; ++i) {
      const handle = this.tabListElement.children[i];
      handle.isActive = i == index;
    }

    this._activeTab = index;

    const page = this.contentElement.children[this._activeTab].children[0];
    if (page) {
      page.repaint(true);
    }
  }

  isPanelVisible(panel) {
    for (let i = 0, l = this.numTabs; i < l; ++i) {
      const h = this.tabListElement.children[i];
      const p = h.page.children[0];
      if (panel === p) return this._activeTab == i;
    }
    return false;
  }

  setActivePanel(panel) {
    for (let i = 0, l = this.numTabs; i < l; ++i) {
      const h = this.tabListElement.children[i];
      const p = h.page.children[0];
      if (panel === p) this.activeTab = i;
    }
  }

  /**
   * Set the tab with the given [handle] has active.
   * @param {TabHandle} handle
   */
  setHandleActive(handle) {
    for (let i = 0, l = this.numTabs; i < l; ++i) {
      const h = this.tabListElement.children[i];
      if (h === handle) this.activeTab = i;
    }
  }

  /**
   * Find the TabWidget that contains the given widget, if any.
   * If a TabWidget is found, then an array with the tab wiget and the actual tab panel
   * is returned.
   * @param {Widget} panel
   * @return {Array?}
   */
  static findParentTabWidget(panel) {
    let p = panel._parent;
    while (p) {
      if (p.constructor.isTabPage) {
        return [p._parent._parent, p];
      }
      p = p._parent;
    }
    return null;
  }
}

TabWidget._idPrefix = 'TABWIDGET';
