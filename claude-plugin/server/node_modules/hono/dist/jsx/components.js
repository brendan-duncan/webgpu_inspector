// src/jsx/components.ts
import { raw } from "../helper/html/index.js";
import { HtmlEscapedCallbackPhase, resolveCallback } from "../utils/html.js";
import { jsx, Fragment, isUntrustedObject, renderChildren, renderUntrustedObject } from "./base.js";
import { DOM_RENDERER } from "./constants.js";
import { captureRenderContext, useContext } from "./context.js";
import { ErrorBoundary as ErrorBoundaryDomRenderer } from "./dom/components.js";
import { StreamingContext } from "./streaming.js";
var errorBoundaryCounter = 0;
var childrenToString = async (children) => {
  try {
    return children.flat().map(resolveChildEarly);
  } catch (e) {
    if (e instanceof Promise) {
      const resume = captureRenderContext();
      await e;
      return resume(() => childrenToString(children));
    } else {
      throw e;
    }
  }
};
var resolveChildEarly = (child) => {
  if (child == null || typeof child === "boolean") {
    return "";
  } else if (typeof child === "string" || Array.isArray(child)) {
    return renderChildren([child]);
  } else if (isUntrustedObject(child)) {
    return renderUntrustedObject(child);
  } else {
    const str = child.toString();
    return str instanceof Promise ? str : raw(str);
  }
};
var ErrorBoundary = async ({ children, fallback, fallbackRender, onError }) => {
  if (!children) {
    return raw("");
  }
  if (!Array.isArray(children)) {
    children = [children];
  }
  const nonce = useContext(StreamingContext)?.scriptNonce;
  let resume;
  const getResume = () => resume ||= captureRenderContext();
  let fallbackStrPromise;
  const resolveFallbackStr = () => fallbackStrPromise ||= (async () => {
    const awaitedFallback = await fallback;
    if (awaitedFallback === null || awaitedFallback === void 0) {
      return;
    }
    if (typeof awaitedFallback === "string" || Array.isArray(awaitedFallback)) {
      return getResume()(() => renderChildren([awaitedFallback]));
    }
    if (isUntrustedObject(awaitedFallback)) {
      return getResume()(() => renderUntrustedObject(awaitedFallback));
    }
    const fallbackResult = await getResume()(() => awaitedFallback.toString());
    return raw(
      fallbackResult,
      fallbackResult.callbacks || awaitedFallback.callbacks
    );
  })();
  const renderFallback = async (error) => {
    const fallbackStr = await resolveFallbackStr();
    return getResume()(async () => {
      onError?.(error);
      const fallbackRes = fallbackStr !== void 0 ? fallbackStr : fallbackRender && jsx(Fragment, {}, fallbackRender(error)) || "";
      const fallbackResString = await Fragment({ children: fallbackRes }).toString();
      return raw(
        fallbackResString,
        fallbackResString.callbacks || fallbackRes.callbacks
      );
    });
  };
  let resArray = [];
  try {
    resArray = children.map(resolveChildEarly);
  } catch (e) {
    const resume2 = getResume();
    if (e instanceof Promise) {
      resArray = [
        e.then(() => resume2(() => childrenToString(children))).catch((e2) => renderFallback(e2))
      ];
    } else {
      resArray = [await renderFallback(e)];
    }
  }
  if (resArray.some((res) => res instanceof Promise)) {
    getResume();
    const index = errorBoundaryCounter++;
    const replaceRe = RegExp(`(<template id="E:${index}"></template>.*?)(.*?)(<!--E:${index}-->)`);
    let caught = false;
    const catchCallback = async ({ error: error2, buffer }) => {
      if (caught) {
        return "";
      }
      caught = true;
      const fallbackResString = await renderFallback(error2);
      const fallbackCallbacks = fallbackResString.callbacks;
      if (buffer) {
        buffer[0] = buffer[0].replace(replaceRe, () => fallbackResString);
        return fallbackCallbacks?.length ? raw("", fallbackCallbacks) : "";
      }
      return raw(
        `<template data-hono-target="E:${index}">${fallbackResString}</template><script>
((d,c,n) => {
c=d.currentScript.previousSibling
d=d.getElementById('E:${index}')
if(!d)return
do{n=d.nextSibling;n.remove()}while(n.nodeType!=8||n.nodeValue!='E:${index}')
d.replaceWith(c.content)
})(document)
</script>`,
        fallbackCallbacks
      );
    };
    let error;
    const promiseAll = Promise.all(resArray).catch((e) => error = e);
    return raw(`<template id="E:${index}"></template><!--E:${index}-->`, [
      ({ phase, buffer, context }) => {
        if (phase === HtmlEscapedCallbackPhase.BeforeStream) {
          return;
        }
        return promiseAll.then(async (htmlArray) => {
          if (error) {
            throw error;
          }
          htmlArray = htmlArray.flat();
          const content = htmlArray.join("");
          let html = buffer ? "" : `<template data-hono-target="E:${index}">${content}</template><script${nonce ? ` nonce="${nonce}"` : ""}>
((d,c) => {
c=d.currentScript.previousSibling
d=d.getElementById('E:${index}')
if(!d)return
d.parentElement.insertBefore(c.content,d.nextSibling)
})(document)
</script>`;
          if (htmlArray.every((html2) => !html2.callbacks?.length)) {
            if (buffer) {
              buffer[0] = buffer[0].replace(replaceRe, () => content);
            }
            return html;
          }
          if (buffer) {
            buffer[0] = buffer[0].replace(
              replaceRe,
              (_all, pre, _, post) => `${pre}${content}${post}`
            );
          }
          const callbacks = htmlArray.map((html2) => html2.callbacks || []).flat();
          if (phase === HtmlEscapedCallbackPhase.Stream) {
            html = await resolveCallback(
              html,
              HtmlEscapedCallbackPhase.BeforeStream,
              true,
              context
            );
          }
          let resolvedCount = 0;
          const promises = callbacks.map(
            (c) => (...args) => c(...args)?.then((content2) => {
              resolvedCount++;
              if (buffer) {
                if (resolvedCount === callbacks.length) {
                  buffer[0] = buffer[0].replace(replaceRe, (_all, _pre, content3) => content3);
                }
                buffer[0] += content2;
                return raw("", content2.callbacks);
              }
              return raw(
                content2 + (resolvedCount !== callbacks.length ? "" : `<script>
((d,c,n) => {
d=d.getElementById('E:${index}')
if(!d)return
n=d.nextSibling
while(n.nodeType!=8||n.nodeValue!='E:${index}'){n=n.nextSibling}
n.remove()
d.remove()
})(document)
</script>`),
                content2.callbacks
              );
            }).catch((error2) => catchCallback({ error: error2, buffer }))
          );
          return raw(html, promises);
        }).catch((error2) => catchCallback({ error: error2, buffer }));
      }
    ]);
  } else {
    return Fragment({ children: resArray });
  }
};
ErrorBoundary[DOM_RENDERER] = ErrorBoundaryDomRenderer;
export {
  ErrorBoundary,
  childrenToString
};
