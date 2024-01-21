import { Div } from './div.js';
import { Signal } from './signal.js';
import { Log } from './log.js';
import { TreeItem } from './tree_item.js';
import { CollapseButton } from './collapse_button.js';
import { TextInput } from './text_input.js';

/**
 * Provides a hierarchical view of items.
 */
export class TreeWidget extends Div {
  constructor(parent, options) {
    if (parent && parent.constructor === Object) {
      options = parent;
      parent = null;
    }

    super(parent, options);

    this.options = options || {};

    this.classList.add('tree-widget');
    this.data = options.data || {};

    this.onBackgroundClicked = new Signal();
    this.onContextMenu = new Signal();
    this.onItemDeselected = new Signal();
    this.onDeselectAll = new Signal();
    this.onItemSelected = new Signal();
    this.onItemDoubleClicked = new Signal();
    this.onItemRenamed = new Signal();
    this.onItemDropped = new Signal();
    this.onItemMoved = new Signal();
    this.onItemContextMenu = new Signal();

    const self = this;

    this.addEventListener('click', function (e) {
      if (e.srcElement !== self.element) return;
      self.onBackgroundClicked.emit(e);
    });

    self.addEventListener('contextmenu', function (e) {
      if (e.button != 2) return false;
      self.onContextMenu.emit(e);
      e.preventDefault();
      return false;
    });

    const rootItem = this.createAndInsert(this.data, this.options, null);
    rootItem.classList.add('tree-root-item');

    this.selection = [];
    this._semiSelected = [];

    this.rootItem = rootItem;
  }

  configure(options) {
    super.configure(options);

    this.allowRename =
      options.allowRename !== undefined ? options.allowRename : false;

    this.allowDrag = options.allowDrag !== undefined ? options.allowDrag : true;

    this.allowMultiSelection =
      options.allowMultiSelection !== undefined
        ? options.allowMultiSelection
        : false;

    this.indentOffset =
      options.indentOffset !== undefined ? options.indentOffset : 0;

    this.collapsedDepth =
      options.collapsedDepth !== undefined ? options.collapsedDepth : 3;
  }

  /**
   * Update the tree with new data. The old data will be discarded.
   * @param {*} data
   */
  setData(data) {
    this.clear(false);
    this.data = data;
    if (data) {
      const rootItem = this.createAndInsert(data, this.options, null);
      if (rootItem) {
        rootItem.classList.add('tree-root-item');
        this.rootItem = rootItem;
      } else this.rootItem = null;
    } else this.rootItem = null;
  }

  /**
   * UpdateInsert an item into the tree.
   * @param {*} data
   * @param {*} parentId
   * @param {*} position
   * @param {*} options
   */
  insertItem(data, parentId, position, options) {
    if (!parentId) {
      const root = this.children[0];
      if (root) parentId = root.itemId;
    }

    const element = this.createAndInsert(data, options, parentId, position);
    return element;
  }

  createAndInsert(data, options, parentId, elementIndex) {
    // Find the parent
    let parentElementIndex = -1;
    if (parentId) parentElementIndex = this._findElementIndex(parentId);
    else if (parentId === undefined) parentElementIndex = 0; // Root

    let parent = null;
    let childLevel = 0;

    // Find the level
    if (parentElementIndex != -1) {
      parent = this.children[parentElementIndex];
      childLevel = parent.level + 1;
    }

    // Create
    const element = this.createTreeItem(data, options, childLevel);
    if (!element) return null;

    element.parentId = parentId;

    // Check
    const existingItem = this.getItem(element.itemId);
    if (existingItem) {
      Log.warning(
        'There is another item with the same ID in this tree.',
        existingItem.id,
        element.id
      );
    }

    // Insert
    if (parentElementIndex == -1) this.appendChild(element);
    else this._insertInside(element, parentElementIndex, elementIndex);

    // Compute visibility according to parents
    if (parent && !this._isNodeChildrenVisible(parentId))
      element.classList.add('hidden');

    // Children
    if (data.children) {
      for (let c of data.children) this.createAndInsert(c, options, data.id);
    }

    // Update collapse button
    if (parentId) this._updateCollapseButton(this._findElement(parentId));

    if (options?.selected) this._markAsSelected(element, true, false);

    if (data.collapsed) this.collapseItem(data.id);

    return element;
  }

  _insertInside(element, parentIndex, offsetIndex, level) {
    const parent = this.children[parentIndex];
    if (!parent)
      throw `No parent node found. Index: ${parentIndex}, nodes: ${this.children.length}`;

    const parentLevel = parent.level;
    const childLevel = level !== undefined ? level : parentLevel + 1;

    const indent = element.indent;
    if (indent) {
      indent.style.paddingLeft =
        (childLevel + this.indentOffset) * TreeWidget.Indent + 'px';
    }

    element.level = childLevel;

    // Under level nodes
    for (let j = parentIndex + 1; j < this.children.length; ++j) {
      const newChildNode = this.children[j];
      if (
        !newChildNode.classList ||
        !newChildNode.classList.contains('tree-item')
      )
        continue;

      const currentLevel = newChildNode.level;

      if (currentLevel == childLevel && offsetIndex) {
        offsetIndex--;
        continue;
      }

      // Last position
      if (
        currentLevel < childLevel ||
        (offsetIndex === 0 && currentLevel === childLevel)
      ) {
        this.insertBefore(element, newChildNode);
        return;
      }
    }

    this.appendChild(element);
  }

  _isNodeChildrenVisible(id) {
    const node = this.getItem(id);
    if (!node) return false;

    if (node.classList.contains('hidden')) return false;

    // Check CollapseButton
    const collapseButton = node.collapseButton;
    if (!collapseButton) return true;

    if (collapseButton.value === 'closed') return false;

    return true;
  }

  _findElement(id) {
    if (!id || id.constructor !== String)
      throw '_findElement param must be a string with item id';

    for (const c of this.children) {
      if (c.itemId == id) return c;
    }
    return null;
  }

  _findElementIndex(id) {
    for (let i = 0, l = this.children.length; i < l; ++i) {
      const childNode = this.children[i];
      if (!childNode.classList || !childNode.classList.contains('tree-item'))
        continue;

      if (id.constructor === String) {
        if (childNode.itemId === id) return i;
      } else if (childNode === id) {
        return i;
      }
    }

    return -1;
  }

  _findElementLastChildIndex(startIndex) {
    if (startIndex == -1) return -1;

    const level = this.children[startIndex].level;

    for (let i = startIndex + 1, l = this.children.length; i < l; ++i) {
      const childNode = this.children[i];
      if (!childNode.classList || !childNode.classList.contains('tree-item'))
        continue;

      const currentLevel = childNode.level;
      if (currentLevel == level) return i;
    }

    return -1;
  }

  _findChildElements(id, onlyDirect) {
    const parentIndex = this._findElementIndex(id);
    if (parentIndex == -1) return;

    const parent = this.children[parentIndex];
    const parentLevel = parent.level;

    const result = [];

    for (let i = parentIndex + 1, l = this.children.length; i < l; ++i) {
      const childNode = this.children[i];
      if (!childNode.classList || !childNode.classList.contains('tree-item'))
        continue;

      const currentLevel = childNode.level;
      if (onlyDirect && currentLevel > parentLevel + 1) continue;

      if (currentLevel <= parentLevel) return result;

      result.push(childNode);
    }

    return result;
  }

  createTreeItem(data, options, level) {
    if (data === null || data === undefined) {
      Log.error('Tree item cannot be null');
      return;
    }

    options = options || this.options;

    const item = new TreeItem({ data, level, class: 'tree-item' });

    const self = this;

    const row = item.element;
    row.addEventListener('click', _onItemSelected);
    row.addEventListener('dblclick', _onItemDoubleClicked);
    row.addEventListener('mousedown', _onItemContextMenu);

    function _onItemContextMenu(e) {
      // Right button
      if (e.button != 2) return;

      e.preventDefault();
      e.stopPropagation();

      _onItemSelected(e);
      self.onItemContextMenu.emit(e, { item, data: item.data });

      return false;
    }

    function _onItemSelected(e) {
      e.preventDefault();
      e.stopPropagation();

      if (item.collapseButton && e.target === item.collapseButton.element)
        return;

      const title = item.titleElement;
      if (title._editing) return;

      if (e.ctrlKey && self.options.allowMultiSelection) {
        // Check if selected
        if (self._isNodeSelected(item)) {
          self._unmarkAsSelected(item);
          return;
        }

        // Mark as selected
        self._markAsSelected(item, true, true);
      } else if (e.shiftKey && self.options.allowMultiSelection) {
        // select from current selection till here
        const lastItem = self.getSelectedItem();
        if (!lastItem) return;

        if (lastItem === item) return;

        const nodeList = lastItem.parent.children;
        const lastIndex = nodeList.indexOf(lastItem);
        const currentIndex = nodeList.indexOf(item);

        const items =
          currentIndex > lastIndex
            ? nodeList.slice(lastIndex, currentIndex + 1)
            : nodeList.slice(currentIndex, lastIndex + 1);

        for (const item of items) {
          // mark as selected
          self._markAsSelected(item, true, true);
        }
      } else {
        self._skipScroll = true; // avoid scrolling while user clicks something

        // mark as selected
        self._markAsSelected(item, false, true);

        self._skipScroll = false;
      }
    }

    function _onItemDoubleClicked(e) {
      e.preventDefault();
      e.stopPropagation();

      const title = item.content;

      self.onItemDoubleClicked.emit(item.data);

      if (!title._editing && self.options.allowRename) {
        title._editing = true;
        title._oldName = title.text;

        const itemTitle = title;
        const itemName = title.text;

        itemTitle.removeAllChildren();

        const input = new TextInput(title, {
          value: itemName,
          style: 'width: 100%;',
        });

        // Loose focus when renaming
        input.element.addEventListener('blur', function (e) {
          const newName = e.target.value;
          // Use a timeout to avoid NotFoundError
          setTimeout(function () {
            itemTitle.removeAllChildren();
            itemTitle.text = newName;
          }, 1);
          delete itemTitle._editing;
          self.onItemRenamed.emit(itemTitle._oldName, newName, item.data);
          delete itemTitle._oldName;
        });

        // Finishes renaming
        input.element.addEventListener('keydown', function (e) {
          if (e.keyCode != 13) return;
          this.blur();
        });

        // set on focus
        input.focus();
        input.select();

        e.preventDefault();
      }
    }

    // Draggin an element on the tree.
    const draggableElement = item.titleElement;
    if (this.options.allowDrag) {
      draggableElement.draggable = true;

      // Start dragging this element
      draggableElement.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('item_id', item.itemId);
        if (data.onDragData) {
          const dragData = data.onDragData();
          if (dragData) {
            for (let i in dragData) e.dataTransfer.setData(i, dragData[i]);
          }
        }
      });
    }

    draggableElement.addEventListener('dragenter', function (e) {
      e.preventDefault();
      if (data.skipDrag) return false;
      item.classList.add('dragover');
    });

    draggableElement.addEventListener('dragleave', function (e) {
      e.preventDefault();
      item.classList.remove('dragover');
    });

    draggableElement.addEventListener('dragover', function (e) {
      e.preventDefault();
    });

    draggableElement.addEventListener('drop', function (e) {
      item.classList.remove('dragover');
      e.preventDefault();
      if (data.skipDrag) return false;

      const dragItemId = e.dataTransfer.getData('item_id');
      if (!dragItemId) {
        self.onItemDropped.emit({
          item: this.parentNode.widget,
          event: e,
        });
        if (self.onDropItem) {
          const dragData = e.parentNode.widget.data;
          self.onDropItem(e, dragData);
        }
        return;
      }

      const dropItemId = this.parentNode.widget.itemId;
      if (
        !self.onMoveItem ||
        (self.onMoveItem &&
          self.onMoveItem(
            self.getItem(dragItemId),
            self.getItem(dropItemId)
          ) !== false)
      ) {
        if (self.moveItem(dragItemId, dropItemId)) {
          self.onItemMoved.emit({
            item: self.getItem(dragItemId),
            parentItem: self.getItem(dropItemId),
          });
        }
      }

      if (self.onDropItem) {
        const dropData = this.parentNode.widget.data;
        self.onDropItem(e, dropData);
      }
    });

    return item;
  }

  // Remove from the tree the items that do not have a name that matches the string.
  filterByName(name) {
    for (let i = 0; i < this.children.length; ++i) {
      const childNode = this.children[i];
      if (!childNode.isTreeItem) continue;

      const content = childNode.content;
      if (!content) continue;

      const str = content.text.toLowerCase();

      if (!name || str.indexOf(name.toLowerCase()) != -1) {
        if (childNode.data && childNode.data.visible !== false)
          childNode.classList.remove('filtered');

        const indent = childNode.indent;
        if (indent) {
          if (name) {
            indent.style.paddingLeft = 0;
          } else {
            const level = childNode.level;
            indent.style.paddingLeft = `${
              (level + this.indentOffset) * TreeWidget.Indent
            }px`;
          }
        }
      } else {
        childNode.classList.add('filtered');
      }
    }
  }

  // Remove from the tree the items that do not have a name that matches the rule.
  filterByRule(callbackToFilter, param) {
    for (let i = 0; i < this.children.length; ++i) {
      const childNode = this.children[i];
      if (!childNode.classList || !childNode.classList.contains('tree-item'))
        continue;

      const content = childNode.content;
      if (!content) continue;

      if (callbackToFilter(childNode.data, content, param)) {
        if (childNode.data && childNode.data.visible !== false)
          childNode.classList.remove('filtered');

        const indent = childNode.indent;
        if (indent) {
          if (name) {
            indent.style.paddingLeft = 0;
          } else {
            const level = childNode.level;
            indent.style.paddingLeft = `${
              (level + this.indentOffset) * TreeWidget.Indent
            }px`;
          }
        }
      } else {
        childNode.classList.add('filtered');
      }
    }
  }

  getItem(id) {
    if (!id) return null;

    if (id.classList) return id;

    for (const c of this.children) {
      if (!c.classList || !c.classList.contains('tree-item')) continue;

      if (c.itemId === id) return c;
    }

    return null;
  }

  /**
   * Expand the item to show its children.
   * @param {*} id
   * @param {*} parents
   */
  expandItem(id, parents) {
    const item = this.getItem(id);
    if (!item) return;

    if (!item.collapseButton) return;

    item.collapseButton.value = true;

    if (!parents) return;

    const parent = this.getParent(item);
    if (parent) this.expandItem(parent, parents);
  }

  /**
   * Collapse the item to hide its children.
   * @param {*} id
   */
  collapseItem(id) {
    const item = this.getItem(id);
    if (!item) return;

    if (!item.collapseButton) return;

    item.collapseButton.value = false;
  }

  /**
   * Checks if the item is out of the view due to scrolling.
   * @param {*} id
   */
  isInsideArea(id) {
    const item = id.constructor === String ? this.getItem(id) : id;
    if (!item) return false;

    const rects = this.element.getClientRects();
    if (!rects.length) return false;

    const r = rects[0];
    const h = r.height;
    const y = item.offsetTop;

    return this.element.scrollTop < y && y < this.element.scrollTop + h;
  }

  /**
   * Scrolls to center the given item.
   * @param {*} id
   */
  scrollToItem(id) {
    const item = id.constructor === String ? this.getItem(id) : id;
    if (!item) return;

    const rects = this.element.getClientRects();
    if (!rects.length) return false;

    const r = rects[0];
    const h = r.height;
    const x = (item.level + this.indentOffset) * TreeWidget.Indent + 50;

    this.element.scrollTop = (item.top - h * 0.5) | 0;
    if (r.width * 0.75 < x) this.element.scrollLeft = x;
    else this.element.scrollLeft = 0;
  }

  /**
   * Mark the item as selected
   * @param {*} id
   * @param {*} scroll
   * @param {*} sendEvent
   */
  setSelectedItem(id, scroll, sendEvent) {
    if (!id) {
      this.deselectAll();
      return;
    }

    const node = this.getItem(id);
    if (!node) return null;

    if (node.classList.contains('selected')) return;

    this._markAsSelected(node, true, false);

    if (scroll && !this._skipScroll) this.scrollToItem(node);

    this.expandItem(node, true);

    if (sendEvent) node.onClick.emit();

    return node;
  }

  /**
   * Adds an item to the selection for multiple selection
   * @param {*} id
   */
  addItemToSelection(id) {
    if (!id) return;

    const node = this.getItem(id);
    if (!node) return null;

    this._markAsSelected(node, true, true);

    return node;
  }

  /**
   * Remove an item from selection for multiple selection
   * @param {*} id
   */
  removeItemFromSelection(id) {
    if (!id) return;
    const node = this.getItem(id);
    if (!node) return null;
    node.classList.remove('selected');
  }

  /**
   * Returns the first selected item.
   */
  getSelectedItem() {
    if (!this.selection.length) return;
    return this.selection[this.selection.length - 1];
  }

  /**
   * Returns an array with the selected items.
   */
  getSelectedItems() {
    return this.selection;
  }

  /**
   * Returns true if an item is selected.
   * @param {*} id
   */
  isItemSelected(id) {
    const node = this.getItem(id);
    if (!node) return false;
    return this._isNodeSelected(node);
  }

  /**
   * Returns the children of an item.
   * @param {*} id
   * @param {*} onlyDirect
   */
  getChildren(id, onlyDirect) {
    if (id && id.constructor !== String && id.itemId !== undefined)
      id = id.itemId;
    return this._findChildElements(id, onlyDirect);
  }

  /**
   * Returns the parent of an item.
   * @param {*} idOrNode
   */
  getParent(idOrNode) {
    const element = this.getItem(idOrNode);
    if (element) return this.getItem(element.parentId);
    return null;
  }

  /**
   * Returns an array with all of the ancestors.
   * @param {*} idOrNode
   * @param {*} result
   */
  getAncestors(idOrNode, result) {
    result = result || [];
    const element = this.getItem(idOrNode);
    if (element) {
      result.push(element);
      return this.getAncestors(element.parentId, result);
    }
    return result;
  }

  /**
   * Returns true if the given node is an ancestor of the child.
   * @param {*} child
   * @param {*} node
   */
  isAncestor(child, node) {
    const element = this.getItem(child);
    if (!element) return false;
    const dest = this.getItem(node);
    const parent = this.getItem(element.parentId);
    if (!parent) return false;
    if (parent === dest) return true;
    return this.isAncestor(parent, node);
  }

  /**
   * Move an item to a new parent.
   * @param {*} id
   * @param {*} parentId
   */
  moveItem(id, parentId) {
    if (id === parentId) return false;

    const node = this.getItem(id);
    const parent = this.getItem(parentId);

    if (this.isAncestor(parent, node)) return false;

    let parentIndex = this._findElementIndex(parent);
    const parentLevel = parent.level;
    const oldParent = this.getParent(node);
    if (!oldParent) {
      Log.error('node parent not found by id, maybe id has changed');
      return false;
    }

    const oldParentLevel = oldParent.level;
    const levelOffset = parentLevel - oldParentLevel;

    if (!parent || !node) return false;

    if (parent == oldParent) return false;

    // replace parent info
    node.parentId = parentId;

    // get all children and subchildren and reinsert them in the new level
    const children = this.getChildren(node);
    if (children) {
      children.unshift(node); // add the node at the beginning

      // remove all children
      for (let i = 0; i < children.length; i++)
        children[i].parentNode.removeChild(children[i]);

      // update levels
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const newLevel = child.level + levelOffset;
        child.level = newLevel;
      }

      // reinsert
      parentIndex = this._findElementIndex(parent); // update parent index
      let lastIndex = this._findElementLastChildIndex(parentIndex);
      if (lastIndex == -1) lastIndex = 0;

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        this._insertInside(child, parentIndex, lastIndex + i - 1, child.level);
      }
    }

    // update collapse button
    this._updateCollapseButton(parent);
    if (oldParent) this._updateCollapseButton(oldParent);

    return true;
  }

  /**
   * Remove an item from the tree.
   * @param {*} idOrNode
   * @param {*} removeChildren
   */
  removeItem(idOrNode, removeChildren) {
    const node = this.getItem(idOrNode);
    if (!node) return false;

    // get parent
    const parent = this.getParent(node);

    // get all descendants
    let childNodes = null;
    if (removeChildren) childNodes = this.getChildren(node);

    // remove html element
    this.removeChild(node);

    // remove all children
    if (childNodes) {
      for (let i = 0; i < childNodes.length; i++)
        this.removeChild(childNodes[i]);
    }

    // update parent collapse button
    if (parent) this._updateCollapseButton(parent);

    return true;
  }

  /**
   * Update the item with new data.
   * @param {*} id
   * @param {*} data
   */
  updateItem(id, data) {
    const node = this.getItem(id);
    if (!node) return false;

    node.data = data;
    if (data.id && node.id != data.id) this.updateItemId(node.id, data.id);

    if (data.content) node.content.element.innerHTML = data.content;

    return true;
  }

  /**
   * Update a given item id and the link with its children.
   * @param {*} oldId
   * @param {*} newId
   */
  updateItemId(oldId, newId) {
    const node = this.getItem(oldId);
    if (!node) return false;

    const children = this.getChildren(oldId, true);
    node.id = newId;

    for (let i = 0; i < children.length; ++i) {
      const child = children[i];
      child.parentId = newId;
    }

    return true;
  }

  /**
   * Clears all of the items from the tree.
   * @param {*} keepRoot
   */
  clear(keepRoot) {
    if (!keepRoot) {
      this.selection.length = 0;
      this.removeAllChildren();
      return;
    }

    this.selection.length = 0;
    for (const i of this.children) {
      i.removeAllChildren();
      if (i.classList.contains('selected')) this.selection.push(i);
    }
  }

  getNodeByIndex(index) {
    return this.children[index];
  }

  deselectAll(notify) {
    if (notify === undefined) notify = true;
    this.selection.length = 0;
    this._semiSelected.length = 0;
    this.classList.remove('selected');
    for (const i of this.children) {
      i.classList.remove('selected');
      i.classList.remove('semiselected');
    }
    if (notify) this.onDeselectAll.emit();
  }

  _isNodeSelected(node) {
    if (node.classList.contains('selected')) return true;
    return false;
  }

  _markAsSelected(node, addToSelection, doCallback) {
    // Already selected
    if (node.classList.contains('selected')) {
      if (addToSelection || this.selection.length == 1) return;
    }

    // Clear old selection
    if (!addToSelection) {
      this.deselectAll(false);
    }

    // Mark as selected (it was node.title_element?)
    if (!node.classList.contains('selected')) {
      node.classList.add('selected');
      this.selection.push(node);
    }

    if (node.classList.contains('semiselected')) {
      node.classList.remove('semiselected');
      const i = this._semiSelected.indexOf(node);
      if (i != -1) this._semiSelected.splice(i, 1);
    }

    // Go up and semiselect
    let parent = this.getParent(node);
    while (parent && !parent.classList.contains('semiselected')) {
      parent.classList.add('semiselected');
      this._semiSelected.push(parent);
      parent = this.getParent(parent);
    }

    if (doCallback) {
      this.onItemSelected.emit(node.data, addToSelection);

      let r = false;
      if (node.data.callback)
        r = node.data.callback.call(self, node.data, addToSelection);

      if (!r && this.itemSelected) this.itemSelected(node.data, addToSelection);
    }
  }

  _unmarkAsSelected(node) {
    if (!node.classList.contains('selected')) return;

    node.classList.remove('selected');

    const i = this.selection.indexOf(node);
    if (i != -1) this.selection.splice(i, 1);

    for (const c of this._semiSelected) c.classList.remove('semiselected');

    this._semiSelected.length = 0;
    for (const c of this.selection) {
      let parent = this.getParent(c);
      while (parent && !parent.classList.contains('semiselected')) {
        parent.classList.add('semiselected');
        this._semiSelected.push(parent);
        parent = this.getParent(parent);
      }
    }

    this.onItemDeselected.emit(node.data);
  }

  /**
   * Update the widget to collapse
   * @param {*} node
   * @param {*} options
   * @param {*} currentLevel
   */
  _updateCollapseButton(node, options, currentLevel) {
    if (!node) return;

    const self = this;
    if (!node.collapseButton) {
      const container = node.collapseButtonArea;

      const collapseButton = new CollapseButton(
        true,
        function (e) {
          self._onClickExpand(e, node);
          //self.onItemCollapseChange.emit({item: node, data: box.value});
        },
        container
      );

      collapseButton.stopPropagation = true;
      collapseButton.setEmpty(true);
      node.collapseButton = collapseButton;
    }

    if ((options && options.collapsed) || currentLevel >= this.collapsedDepth)
      node.collapseButton.collapse();

    const childElements = this.getChildren(node.itemId);
    if (!childElements) return; //null

    if (childElements.length) node.collapseButton.setEmpty(false);
    else node.collapseButton.setEmpty(true);
  }

  _onClickExpand(e, node) {
    const children = this.getChildren(node);

    if (!children) return;

    // Update children visibility
    for (const child of children) {
      const childParent = this.getParent(child);
      var visible = true;
      if (childParent) visible = this._isNodeChildrenVisible(childParent);
      if (visible) child.classList.remove('hidden');
      else child.classList.add('hidden');
    }
  }
}

TreeWidget.Indent = 20;
