import { Div } from './div.js';
import { Span } from './span.js';
import { Widget } from './widget.js';

/**
 * A collapsable widget with a header and a body.
 */
export class Collapsable extends Widget {
  constructor(parent, options) {
    super('div', parent, options);

    const collapsed = options.collapsed ?? false;

    this.titleBar = new Div(this, { class: "title_bar" });
    this.collapseButton = new Span(this.titleBar, { class: "object_list_collapse", text: collapsed ? "+" : "-", style: "margin-right: 10px;" })
    this.label = new Span(this.titleBar, { class: "object_type", text: options?.label ?? "" });

    this.body = new Div(this, { class: ["object_list"] });
    if (collapsed) {
      this.body.element.className = "object_list collapsed";
    }

    const self = this;

    this.titleBar.element.onclick = function() {
      if (self.collapseButton.text == "-") {
        self.collapseButton.text = "+";
        self.body.element.className = "object_list collapsed";
      } else {
        self.collapseButton.text = "-";
        self.body.element.className = "object_list";
      }
    };
  }
}
