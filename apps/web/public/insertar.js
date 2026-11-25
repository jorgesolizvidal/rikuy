/*
 * Rikuy · the municipality's assistant inside its own website (ADR-071).
 *
 *   <script src="https://{the municipality's address in Rikuy}/insertar.js" async></script>
 *
 * Optional, on a page about one place: data-lugar="destinos/{address}" or "agenda/{address}".
 *
 * It asks Rikuy for the assistant's name and colors; Rikuy answers only to the websites the
 * municipality authorized, so anywhere else nothing is shown. The assistant itself opens in a
 * frame served by Rikuy, which only those websites may show.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || !script.src || window.__rikuyAssistant) return;
  window.__rikuyAssistant = true;

  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch {
    return;
  }
  var place = script.getAttribute("data-lugar") || "";
  var PHONE = "(max-width: 40rem)";

  function mount(brand) {
    var host = document.createElement("div");
    host.setAttribute("data-rikuy-assistant", "");
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = document.createElement("style");
    style.textContent =
      ":host{all:initial}" +
      ".launcher{position:fixed;right:1rem;bottom:1rem;z-index:2147483646;display:inline-flex;" +
      "align-items:center;gap:.5rem;min-height:3rem;padding:.65rem 1.1rem;border:0;" +
      "border-radius:999px;background:" +
      brand.brand +
      ";color:" +
      brand.onBrand +
      ";" +
      "font:600 1rem/1.2 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
      "box-shadow:0 6px 24px rgb(0 0 0 / .25);cursor:pointer}" +
      ".launcher:focus-visible{outline:3px solid " +
      brand.focus +
      ";outline-offset:3px}" +
      ".launcher[hidden]{display:none}" +
      ".launcher svg{flex:none}" +
      ".frame{position:fixed;right:1rem;bottom:1rem;z-index:2147483647;width:min(28rem,calc(100vw - 2rem));" +
      "height:min(42rem,calc(100vh - 2rem));border:0;border-radius:1rem;background:#fff;" +
      "box-shadow:0 12px 48px rgb(0 0 0 / .3);color-scheme:normal}" +
      ".frame[hidden]{display:none}" +
      "@media " +
      PHONE +
      "{.frame{inset:0;width:100%;height:100%;border-radius:0}}";
    root.appendChild(style);

    var button = document.createElement("button");
    button.type = "button";
    button.className = "launcher";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" focusable="false">' +
      '<path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>';
    var label = document.createElement("span");
    label.textContent = brand.label;
    button.appendChild(label);
    root.appendChild(button);

    var frame = null;
    function prepare() {
      if (frame) return frame;
      frame = document.createElement("iframe");
      frame.className = "frame";
      frame.hidden = true;
      frame.title = brand.title;
      frame.setAttribute("allow", "microphone; geolocation");
      frame.src = origin + "/insertar" + (place ? "?lugar=" + encodeURIComponent(place) : "");
      root.appendChild(frame);
      return frame;
    }

    function open() {
      var opened = prepare();
      opened.hidden = false;
      button.hidden = true;
      button.setAttribute("aria-expanded", "true");
      try {
        opened.focus();
      } catch {
        /* the frame takes the focus itself once it loads */
      }
      if (opened.contentWindow) opened.contentWindow.postMessage({ type: "rikuy:open" }, origin);
    }

    function close() {
      if (!frame) return;
      frame.hidden = true;
      button.hidden = false;
      button.setAttribute("aria-expanded", "false");
      button.focus();
    }

    button.addEventListener("pointerenter", prepare);
    button.addEventListener("focus", prepare);
    button.addEventListener("click", open);
    window.addEventListener("message", function (event) {
      if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
      var data = event.data;
      if (data && data.type === "rikuy:close") close();
      if (data && data.type === "rikuy:ready" && !frame.hidden && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: "rikuy:open" }, origin);
      }
    });

    (document.body || document.documentElement).appendChild(host);
  }

  function start() {
    fetch(origin + "/insertar/marca", { credentials: "omit", mode: "cors" })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (brand) {
        if (brand && typeof brand.label === "string") mount(brand);
      })
      .catch(function () {
        /* not authorized here, or Rikuy cannot be reached: nothing is shown */
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
