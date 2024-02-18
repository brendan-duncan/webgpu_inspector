import { Div } from './div.js';
import { Span } from './span.js';
import { Widget } from './widget.js';
import { Signal } from '../../utils/signal.js';

/**
 * A collapsable widget with a header and a body.
 */
export class Collapsable extends Widget {
  constructor(parent, options) {
    super('div', parent, options);

    const collapsed = options.collapsed ?? false;

    this.titleBar = new Div(this, { class: "title_bar" });
    this.collapseButton = new Span(this.titleBar, { class: "collapsable_button", text: collapsed ? "+" : "-", style: "margin-right: 10px;" })
    this.label = new Span(this.titleBar, { class: "object_type", text: options?.label ?? "" });
    this.onExpanded = new Signal();
    this.onCollapsed = new Signal();

    this.body = new Div(this, { class: ["collapsable_body"] });
    if (collapsed) {
      this.body.element.className = "collapsable_body collapsed";
    }

    const self = this;

    this.titleBar.element.onclick = function() {
      if (self.collapseButton.text == "-") {
        self.collapseButton.text = "+";
        self.body.element.className = "collapsable_body collapsed";
        self.onCollapsed.emit();
      } else {
        self.collapseButton.text = "-";
        self.body.element.className = "collapsable_body";
        self.onExpanded.emit();
      }
    };
  }

  expand() {
    this.collapsed = false;
  }

  get collapsed() {
    return this.collapseButton.text == "+";
  }

  set collapsed(value) {
    if (this.collapsed == value) {
      return;
    }
    if (value) {
      this.collapseButton.text = "+";
      this.body.element.className = "collapsable_body collapsed";
      this.onCollapsed.emit();
    } else {
      this.collapseButton.text = "-";
      this.body.element.className = "collapsable_body";
      this.onExpanded.emit();
    }
  }
}
