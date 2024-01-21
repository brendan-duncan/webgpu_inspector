import { Widget } from './widget.js';
import { Signal } from './signal.js';
import { Log } from './log.js';

/**
 * Menus present a hierarchical list of actions, and can either be part of a menubar or a context
 * menu.
 */
export class Menu extends Widget {
  constructor(options) {
    super();

    this.items = [];
    this.parentMenu = null;
    this._displayedSubMenu = null;
    this._clickCount = 0;
    this.isContextMenu = false;

    this.onAboutToShow = new Signal();
    this.onAboutToHide = new Signal();

    this._clickCallbackHandle = this._clickCallback.bind(this);

    this.options = options;
    if (options) this.configure(options);
  }

  get element() {
    return this._element;
  }

  static contextMenu(options, event) {
    if (!options) return;

    if (Menu.activeContextMenu) {
      Menu.activeContextMenu.hideAll();
      Menu.activeContextMenu = null;
    }

    options.isContextMenu = true;
    const menu = new Menu(options);
    Menu.activeContextMenu = menu;
    menu.event = event;
    menu.show(
      event.pageX,
      event.pageY /*- (event.pointerType === "touch" ? 100 : 0)*/
    );
  }

  configure(options) {
    if (options.isContextMenu !== undefined)
      this.isContextMenu = options.isContextMenu;

    if (options.aboutToShow !== undefined)
      this.onAboutToShow.addListener(options.aboutToShow);

    if (options.items !== undefined) this.addItems(options.items);
  }

  setItems(items, options) {
    this.clear();
    this.addItems(items, options);
  }

  addItems(items, options) {
    options = options || {};
    for (const i of items) {
      // Undefined items will be skipped all-together
      if (i === undefined) continue;

      // null or empty-string items will become separators
      if (!i) {
        this.addSeparator();
      } else if (i.menu) {
        const label = i.label || '<i>undefined</i>';
        const menu = this.addMenu(
          label,
          i.menu.constructor === Object ? i.menu : i
        );
        if (i.menu.constructor === Function)
          menu.onAboutToShow.addListener(i.menu);
        else if (i.menu.constructor === Array) menu.addItems(i.menu);
        if (i.callback && i.menu.constructor !== Function)
          menu.onAboutToShow.addListener(i.callback);
      } else if (i.widget) {
        this.addWidget(i.widget);
      } else if (i.constructor === String) {
        if (options.callback) this.addAction(i, options.callback);
        else this.addAction(i, null, { disabled: true });
      } else if (i.constructor === Object) {
        const label = i.label || '<i>undefined</i>';
        let callback = i.callback || options.callback || null;
        this.addAction(label, callback, i);
      }
    }
  }

  clear() {
    this.items.length = 0;
  }

  /**
   * Add an action menu item.
   * @param {String} label The name of the action
   * @param {Object?} options The optional configuration of the action:
   *      Possible options are:
   *          {bool} disabled
   */
  addWidget(widget, options) {
    options = options || {};
    const item = { widget: widget };

    item.parentMenu = this;
    item.options = options;

    this.items.push(item);
    return item;
  }

  /**
   * Add an action menu item.
   * @param {String} label The name of the action
   * @param {Function?} callback The function that will be called when the action is executed.
   * @param {Object?} options The optional configuration of the action:
   *      Possible options are:
   *          {String} shortcut
   *          {String} value
   *          {bool} checkable
   *          {bool} checked
   *          {bool} disabled
   */
  addAction(label, callback, options) {
    options = options || {};
    const item = { label: label };

    if (callback) item.callback = callback;

    if (options.value !== undefined) item.value = options.value;

    if (options.shortcut !== undefined) item.shortcut = options.shortcut;

    if (options.checked !== undefined && options.checkable === undefined)
      options.checkable = true;

    if (options.checkable !== undefined) item.checkable = options.checkable;

    if (options.checked !== undefined) item.checked = options.checked;

    if (options.disabled !== undefined) item.disabled = options.disabled;

    item.parentMenu = this;
    item.options = options;

    this.items.push(item);
    return item;
  }

  /**
   * Add a separator menu item.
   */
  addSeparator() {
    this.items.push({ separator: true });
  }

  /**
   * Add a sub-menu
   * @param {String} label The name of the sub-menu
   * @param {Object?} options
   * @return {Menu} The new sub-menu object.
   */
  addMenu(label, options) {
    const menu = new Menu(options);
    menu.parentMenu = this;
    const menuItem = { label: label, menu: menu, options: options };
    if (options && options.disabled !== undefined)
      menuItem.disabled = options.disabled;
    this.items.push(menuItem);
    return menu;
  }

  /**
   * Show the menu at the given coordinates.
   * @param {number} x
   * @param {number} y
   * @param {number?} px used for sub-menus
   */
  show(x, y, parentMenu) {
    this._displayedSubMenu = null;
    this.x = x;
    this.y = y;

    if (!this._element) {
      this.onAboutToShow.emit(this);
      this._element = this._createMenu(this.items);
      document.body.appendChild(this._element);

      this._clickCount = 0;
      document.addEventListener('pointerup', this._clickCallbackHandle);
    }

    this._element.style.display = '';

    this._updatePositionToView(x, y, parentMenu);

    this._element.style.maxHeight = '400px';
    this._element.style.overflow = 'auto';

    // Use a timeout to re-adjust the position to account for mobile keyboards popping
    // up, changing the window size.
    const self = this;
    setTimeout(() => {
      self._updatePositionToView(x, y, parentMenu);
    }, 150);
  }

  _updatePositionToView(x, y, parentMenu) {
    if (!this._element) return;
    const h = this._element.clientHeight;
    const w = this._element.clientWidth;

    const wh = window.innerHeight;
    const ww = window.innerWidth;

    if (y + h > wh) y -= y + h - wh + 20;

    const maxRight = x + w + 10;
    if (maxRight > ww) {
      x -= maxRight - ww;
      if (parentMenu) {
        const rect = parentMenu.getBoundingClientRect();
        x = rect.left + rect.width / 4 - w;
      }
    }

    this._setPosition(x, y);
  }

  /**
   * Hide the menu
   */
  hide() {
    this.onAboutToHide.emit(this);
    this._clickCount = 0;
    if (this._displayedSubMenu) {
      this._displayedSubMenu._destroy();
      this._displayedSubMenu = null;
    }
    this._destroy();
  }

  /**
   * Hide this menu and all parent menus
   */
  hideAll() {
    const p = this.parentMenu;
    this.hide();
    if (p) p.hideAll();
  }

  /**
   * Get the top-most parent menu, which may be this menu.
   * @return {Menu}
   */
  getTopMenu() {
    let p = this;
    while (p.parentMenu) p = p.parentMenu;
    return p;
  }

  _clickCallback(e) {
    if (e.target.classList.contains('menu_item')) return;

    if (this._clickCount == 0) {
      if (this.isContextMenu) {
        const dx = Math.abs(e.pageX - this.x);
        const dy = Math.abs(e.pageY - this.y);
        const distance = dx * dx + dy * dy;
        const threshold = 4;
        if (!e.target.parentNode.isMenuWidget && distance > threshold) {
          this.hideAll();
          Menu.activeContextMenu = null;
          document.removeEventListener('pointerup', this._clickCallbackHandle);
        }
      } else if (
        !e.target.classList.contains('menubar_item') &&
        !e.target.classList.contains('menubar')
      ) {
        this.hideAll();
        document.removeEventListener('pointerup', this._clickCallbackHandle);
      }
    } else {
      if (!e.target.parentNode || !e.target.parentNode.isMenuWidget) {
        this.hideAll();
        document.removeEventListener('pointerup', this._clickCallbackHandle);
      }
    }
    this._clickCount++;
  }

  /**
   * Destroy the menu
   */
  _destroy() {
    if (!this._element) return;
    if (this._displayedSubMenu) this._displayedSubMenu._destroy();
    this._element.style.display = 'none';
    this._element.remove();
    this._element = null;
  }

  /**
   * Create the menu. The menu will be created the first time it"s shown.
   * @param {Array} items
   * @return {Menu}
   */
  _createMenu(items) {
    const menu = document.createElement('div');
    menu.addEventListener('contextmenu', function (e) {
      e.stopPropagation();
      e.preventDefault();
    });

    menu.classList.add('menu');
    menu.widget = this;

    for (const item of items) {
      let menuItem;
      if (item.menu !== undefined) menuItem = this._createSubMenuItem(item);
      else if (item.separator !== undefined) menuItem = this._createSeparator();
      else menuItem = this._createItem(item);
      menu.appendChild(menuItem);
    }

    return menu;
  }

  /**
   * Set the position of the menu element.
   * @param {number} x
   * @param {number} y
   */
  _setPosition(x, y) {
    if (!this._element) return;
    this._element.style.left = `${x}px`;
    this._element.style.top = `${y}px`;
  }

  /**
   * Create a separator item.
   */
  _createSeparator() {
    const sep = document.createElement('div');

    sep.addEventListener('dragstart', function (e) {
      e.stopPropagation();
      e.preventDefault();
    });

    sep.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
    });

    sep.addEventListener('contextmenu', function (e) {
      e.stopPropagation();
      e.preventDefault();
    });

    sep.classList.add('menu_separator');

    return sep;
  }

  /**
   * Create a menu item.
   * @param {Object} item
   */
  _createItem(item) {
    const self = this;

    const element = document.createElement('div');
    element.classList.add('menu_item');

    if (item.disabled) element.classList.add('disabled');

    if (item.widget) {
      if (item.widget.constructor === String) element.innerHTML = item.widget;
      else element.appendChild(item.widget.element);
      element.isMenuWidget = true;
      return element;
    }

    element.addEventListener('contextmenu', function (e) {
      e.stopPropagation();
      e.preventDefault();
    });

    element.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
    });

    const callback = item.callback;
    element.addEventListener('pointerup', function (e) {
      if (callback) {
        item.event = e;
        item.topMenu = item.parentMenu.getTopMenu();
        item.topEvent = item.topMenu.event;
        item.element = element;
        try {
          callback(item);
        } catch (error) {
          Log.error(error);
        }
        item.element = null;
      }
      self.getTopMenu().hide();
      e.stopPropagation();
      e.preventDefault();
    });

    // Background style is set here instead of :hover css because doing it
    // here supports updating while the mouse is pressed.
    element.addEventListener('pointerover', function () {
      if (self._displayedSubMenu) {
        self._displayedSubMenu.hide();
        self._displayedSubMenu = null;
      }
    });

    element.innerHTML = item.label;

    if (item.shortcut !== undefined) {
      const shortcut = document.createElement('span');
      shortcut.classList.add('menu_item_shortcut');
      shortcut.innerHTML = item['shortcut'];
      element.appendChild(shortcut);
    }

    if (item.checkable !== undefined && item.checkable) {
      const checkbox = document.createElement('input');
      checkbox.classList.add('menu_item_checkbox');
      checkbox.type = 'checkbox';
      if (item.checked !== undefined && item.checked) checkbox.checked = true;
      element.appendChild(checkbox);
    }

    return element;
  }

  /**
   * Create a sub-menu item.
   * @param {Object} item
   */
  _createSubMenuItem(item) {
    const self = this;
    const element = document.createElement('div');

    element.addEventListener('contextmenu', function (e) {
      e.stopPropagation();
      e.preventDefault();
    });

    element.classList.add('menu_item');

    if (item.disabled) element.classList.add('disabled');

    if (!item.disabled) {
      element.addEventListener('pointerover', function (e) {
        if (self._displayedSubMenu) {
          self._displayedSubMenu.hide();
          self._displayedSubMenu = null;
        }
        self._showSubMenu(e, element, item);
      });

      element.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (self._displayedSubMenu) {
          self._displayedSubMenu.hide();
          self._displayedSubMenu = null;
        }
        self._showSubMenu(e, element, item);
      });

      element.addEventListener('pointerout', function (e) {
        const x = element.offsetLeft + element.parentElement.offsetLeft;
        const y = element.offsetTop + element.parentElement.offsetTop;
        const h = element.offsetHeight;

        if (e.clientX < x || e.clientY < y || e.clientY > y + h)
          self._hideSubMenu(item);
      });
    }

    element.innerHTML = item.label;

    let arrow = document.createElement('div');
    arrow.innerHTML = '\u25B8';
    arrow.classList.add('submenu_arrow');
    element.appendChild(arrow);

    return element;
  }

  /**
   * Show a sub-menu
   * @param {Event} event
   * @param {DOMElement} element
   * @param {Object} item
   */
  _showSubMenu(event, element, item) {
    this._displayedSubMenu = item.menu;
    const menu = item.menu;
    if (menu && element) {
      const x = element.offsetLeft + element.parentElement.offsetLeft;
      const y = element.offsetTop + element.parentElement.offsetTop;
      const w = element.clientWidth;
      menu.show(x + w - 12, y, this);
    }
  }

  /**
   * Hide a sub-menu
   * @param {Object} item
   */
  _hideSubMenu(item) {
    this._displayedSubMenu = null;
    const menu = item['menu'];
    if (menu) menu.hide();
  }
}

Menu.isMenu = true;
Menu._idPrefix = 'MENU';
Menu.activeContextMenu = null;
