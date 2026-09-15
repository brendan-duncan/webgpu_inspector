// src/jsx/dom/server.ts
import { renderChildren } from "../base.js";
import { renderToReadableStream as renderToReadableStreamHono } from "../streaming.js";
import version from "./index.js";
var prepareRoot = (element) => typeof element === "string" || Array.isArray(element) ? renderChildren([element]) : element;
var renderToString = (element, options = {}) => {
  if (Object.keys(options).length > 0) {
    console.warn("options are not supported yet");
  }
  element = prepareRoot(element);
  const res = element instanceof Promise ? element : element?.toString() ?? "";
  if (typeof res !== "string") {
    throw new Error("Async component is not supported in renderToString");
  }
  return res;
};
var renderToReadableStream = async (element, options = {}) => {
  if (Object.keys(options).some((key) => key !== "onError")) {
    console.warn("options are not supported yet, except onError");
  }
  element = prepareRoot(element);
  if (!element || typeof element !== "object") {
    element = element?.toString() ?? "";
  }
  return renderToReadableStreamHono(element, options.onError);
};
var server_default = {
  renderToString,
  renderToReadableStream,
  version
};
export {
  server_default as default,
  renderToReadableStream,
  renderToString,
  version
};
