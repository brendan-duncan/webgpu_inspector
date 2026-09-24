import { Button } from "./button.js";
import { Img } from "./img.js";

/**
 * An icon button that opens a documentation page in a new tab.
 * @param {Widget} parent
 * @param {string} url - the documentation page
 * @param {Object} [options] - extra Button options (class, style, ...)
 * @returns {Button}
 */
export function createHelpButton(parent, url, options = {}) {
  return new Button(parent, {
    ...options,
    class: `btn icon-button ${options.class ?? ""}`.trim(),
    title: options.title ?? "Help",
    children: [new Img(null, { src: "img/help.svg", style: "width: 15px; height: 15px; filter: invert(1); vertical-align: middle;" })],
    callback: () => window.open(url, "_blank"),
  });
}
