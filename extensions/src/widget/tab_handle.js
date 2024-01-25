import { Div } from './div.js';
import { Widget } from "./widget.js";

/**
 * The handle widget for a tab panel.
 */
export class TabHandle extends Div {
  constructor(title, page, parentWidget, parent, options) {
    super(parent);

    this.title = title;
    this.page = page;
    this.parentWidget = parentWidget;

    this.classList.add('tab-handle', 'disable-selection');

    this.textElement = new Div(this, {
      class: 'tab-handle-text',
      text: title,
    });

    this.draggable = true;

    this.enableMouseEvents();
    this.enableDoubleClickEvent();

    this.configure(options);

    this.enableDropEvents();
  }

  dragStartEvent() {
    TabHandle.DragWidget = this;
  }

  dragEndEvent() {
    TabHandle.DragWidget = null;
  }

  dragOverEvent(e) {
    if (!TabHandle.DragWidget) return;

    if (
      e.srcElement.classList.contains('tab-handle') &&
      this !== TabHandle.DragWidget
    ) {
      if (e.layerX < this.width * 0.5) {
        e.preventDefault();
        this.style.borderRight = '';
        this.style.borderLeft = '4px solid #fff';
      } else {
        e.preventDefault();
        this.style.borderLeft = '';
        this.style.borderRight = '4px solid #fff';
      }
    }
  }

  dropEvent(e) {
    this.style.borderLeft = '';
    this.style.borderRight = '';
    if (e.srcElement.classList.contains('tab-handle')) {
      if (e.layerX < this.width * 0.5) console.log('Insert Before');
      else console.log('Insert After');
    }
  }

  dragEnterEvent() {
    this.style.borderLeft = '';
    this.style.borderRight = '';
  }

  dragLeaveEvent() {
    this.style.borderLeft = '';
    this.style.borderRight = '';
  }

  configure(options) {
    if (!options) return;
    super.configure(options);
    if (options.displayCloseButton) {
      this.closeButton = new Div(this, {
        class: 'tab-handle-close-button',
      });

      // Set the close button text
      const closeIcon = 'icon-remove-sign';
      this.closeButton.element.innerHTML = `<i class="${closeIcon}">x</i>`;
    }
  }

  /**
   * Is this tab currently active?
   */
  get isActive() {
    return this.classList.contains('tab-handle-selected');
  }

  /**
   * Set the active state of the tab (does not affect other tabs, which should
   * be set as inactive).
   */
  set isActive(a) {
    if (a == this.isActive) return;

    if (a) {
      this.classList.add('tab-handle-selected');
      this.page.style.display = 'block';
      this.style.zIndex = '10';
    } else {
      this.classList.remove('tab-handle-selected');
      this.page.style.display = 'none';
      this.style.zIndex = '0';
    }
  }

  mousePressEvent(e) {
    this.parentWidget.setHandleActive(this);
  }

  doubleClickEvent() {
    this.maximizePanel();
  }

  maximizePanel() {
    Widget.window.maximizePanelToggle(this.title, this.page.panel);
  }
}

TabHandle._idPrefix = 'TAB';
