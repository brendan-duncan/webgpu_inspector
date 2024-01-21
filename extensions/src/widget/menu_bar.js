import { Div } from './div.js';
import { Menu } from './menu.js';

/**
 * A MenuBar creates a horizontal element with menu items.
 */
export class MenuBar extends Div {
  constructor(parent, options) {
    super(parent, options);
    this._element.classList.add('menubar');
    this.menuContents = document.createElement('span');
    this.menuContents.classList.add('menubar_items');
    this._element.appendChild(this.menuContents);
    this._menuItems = [];
    this._menus = [];
    this._displayedMenu = null;
  }

  /**
   * How many menus on the menubar?
   */
  get numItems() {
    return this._menuItems.length;
  }

  /**
   * Get the list of menu DOM elements.
   */
  get menuItems() {
    return this._menuItems;
  }

  /**
   * Get the list of Menus.
   */
  get menus() {
    return this._menus;
  }

  /**
   * Add a widget to the menubar.
   * @param {*} elementOrWidget
   */
  addMenuWidget(elementOrWidget) {
    if (!elementOrWidget) return;
    if (elementOrWidget.constructor.isWidget)
      this.menuContents.appendChild(elementOrWidget.element);
    else this.menuContents.appendChild(elementOrWidget);
  }

  /**
   * Add an action (clickable label) to the menubar.
   * @param {*} label String or Widget
   * @param {Function} callback
   */
  addAction(label, callback) {
    let menuItem;
    if (label.constructor.isWidget) {
      menuItem = label.element;
    } else {
      menuItem = document.createElement('span');
      menuItem.innerHTML = label;
    }
    menuItem.classList.add('menubar_item');
    this.menuContents.appendChild(menuItem);
    menuItem.addEventListener('click', function (e) {
      callback(e);
    });
  }

  /**
   * Add a menu to the menubar.
   * @param {*} label
   * @param {*} menu
   */
  addMenu(label, menu) {
    let menuItem;
    if (label.constructor.isWidget) {
      menuItem = label.element;
    } else {
      menuItem = document.createElement('span');
      menuItem.innerHTML = label;
    }
    menuItem.classList.add('menubar_item');
    this.menuContents.appendChild(menuItem);
    this._menuItems.push(menuItem);

    menu = menu || new Menu();
    this._menus.push(menu);

    const self = this;

    menuItem.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      if (self._displayedMenu) {
        self._displayedMenu.hide();
        self._displayedMenu = null;
        return;
      }
      self._displayedMenu = menu;
      const r = menuItem.getBoundingClientRect();
      menu.show(r.left, r.top + menuItem.offsetHeight + 5);
    });

    menu.onAboutToHide.addListener(this._onMenuHide, this);

    menuItem.addEventListener('mouseover', function () {
      if (self._displayedMenu && menuItem !== self._displayedMenu) {
        self._displayedMenu.hide();
        self._displayedMenu = menu;
        const r = menuItem.getBoundingClientRect();
        menu.show(r.left, r.top + menuItem.offsetHeight + 5);
      }
    });

    return menu;
  }

  _onMenuHide(menu) {
    if (this._displayedMenu === menu) this._displayedMenu = null;
  }

  /**
   * Remove all menus from the menubar.
   */
  removeAllChildren() {
    while (this.menuContents.lastElementChild)
      this.menuContents.removeChild(this.menuContents.lastElementChild);
    this._menus.length = 0;
    this._menuItems.length = 0;
    this._displayedMenu = null;
  }
}

MenuBar.isMenuBar = true;
MenuBar._idPrefix = 'MENUBAR';
