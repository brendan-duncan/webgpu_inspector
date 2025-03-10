import { Signal } from '../../utils/signal.js';
import { Widget } from "./widget.js";
import { Div } from "./div.js";
import { Span } from "./span.js";

export class TreeItem extends Widget {
  constructor(parent, options) {
    if (parent && parent.constructor === Object) {
      options = parent;
      parent = null;
    }

    super("li", parent, options);

    options = options || {};
    this.data = options.data || {};
    this.itemId = this.data.id || "";
    this.level = options.level || 0;
    this.collapseButton = null;
    this.onClick = new Signal();
    this.data.item = this;

    this.titleElement = new Div(this, {class: "tree-item-title"});
    this.preContent = new Span(this.titleElement, {class:"precontent"});
    this.indent = new Span(this.titleElement, {class:"indent"});
    this.collapseButtonArea = new Span(this.titleElement, {class:"tree-collapse"});
    this.icon = new Span(this.titleElement, {class:"icon"});
    this.content = new Span(this.titleElement, {class:"content"});
    this.postContent = new Span(this.titleElement, {class:"postcontent"});

    if (this.data.className) {
      this.titleElement.classList.add(this.data.className);
    }

    if (this.data.icon) {
      if (this.data.icon.constructor === Function) {
        this.data.icon(this.icon, this.data);
      } else {
        this.icon.element.innerHTML = this.data.icon;
      }
    }

    if (this.data.content) {
      if (this.data.content.constructor === Function) {
        this.data.content(this.content, this.data);
      } else if (this.data.content instanceof Span) {
        this.content.appendChild(this.data.content);
      } else {
        this.content.text = this.data.content || this.data.id || "";
      }
    } else {
      this.content.element.text = this.data.id || "";
    }

    if (this.data.precontent) {
      if (this.data.precontent.constructor === Function) {
        this.data.precontent(this.preContent, this.data);
      } else {
        this.preContent.element.innerHTML = this.data.precontent;
      }
    }

    if (this.data.postcontent) {
      if (this.data.postcontent.constructor === Function) {
        this.data.postcontent(this.postContent, this.data);
      } else {
        this.postContent.element.innerHTML = this.data.postcontent;
      }
    }

    if (this.data.visible === false) {
      this.style.display = "none";
    }
  }
}

TreeItem.isTreeItem = true;
