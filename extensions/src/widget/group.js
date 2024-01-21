import { Div } from './div.js';
import { Widget } from './widget.js';
import { Span } from './span.js';
import { Signal } from '../../../runtime/util/signal.js';

export class Group extends Div {
  constructor(name, parent, options) {
    super(parent, options);
    this.classList.add('group');

    this.onCollapsed = new Signal();
    this.onExpanded = new Signal();

    this._collapsed = false;
    this._savedWidth = 0;
    this._savedHeight = 0;

    this.header = new Div(this, { class: 'group-header' });
    this.itemExpand = new Widget('i', this.header, {
      class: ['fas', 'fa-caret-down', 'collapse'],
    });

    const self = this;
    this.itemExpand.element.addEventListener('click', function () {
      self.collapsed = !self.collapsed;
    });

    this.preLabel = new Span(this.header, { class: 'group-prelabel' });
    this.label = new Widget('a', this.header, { text: name, stretch: 1 });
    this.postLabel = new Span(this.header, { class: 'group-postlabel' });

    this.contents = new Div(this, { class: 'group-contents' });
  }

  get collapsed() {
    return this._collapsed;
  }

  set collapsed(v) {
    this._collapsed = !!v;
    if (this._collapsed) {
      this._savedHeight = this.contents.height + 10;
      this._savedWidth = this.contents.width;
      this.contents.element.style.display = 'none';
      this.itemExpand.classList.remove('fa-caret-down');
      this.itemExpand.classList.add('fa-caret-right');
      this.onCollapsed.emit();
    } else {
      this.contents.element.style.display = 'block';
      this.itemExpand.classList.add('fa-caret-down');
      this.itemExpand.classList.remove('fa-caret-right');
      this.onExpanded.emit();
    }
  }
}
