import { Span } from "./span.js";

export class CollapseButton extends Span {
  constructor(state, onChange, parent, options) {
    super(parent, options);
    this.onChange = onChange;

    this.classList.add("collapse-button", state ? "collapse-button-open" : "collapse-button-closed");
    this.element.innerHTML = state ? "&#9660;" : "&#9658;";
    this.element.dataset["value"] = state ? "open" : "closed";

    this.addEventListener("click", onClick);
    const self = this;
    function onClick(e) {
      self.value = this.dataset["value"] === "open" ? false : true;
      if (self.stopPropagation) {
        e.stopPropagation;
      }
    }
  }

  setEmpty(v) {
    if (v) {
      this.classList.add("empty");
    } else {
      this.classList.remove("empty");
    }
  }

  expand() {
    this.value = true;
  }

  collapse() {
    this.value = false;
  }

  set value(v) {
    if (this.dataset["value"] == (v ? "open" : "closed")) {
      return;
    }

    if (!v) {
      this.dataset["value"] = "closed";
      this.element.innerHTML = "&#9658;";
      this.classList.remove("collapse-button-open");
      this.classList.add("collapse-button-closed");
    } else {
      this.dataset["value"] = "open";
      this.element.innerHTML = "&#9660;";
      this.classList.add("collapse-button-open");
      this.classList.remove("collapse-button-closed");
    }

    if (this.onChange) {
      this.onChange(this.dataset["value"]);
    }
  }

  get value() {
    return this.dataset["value"];
  }
}
