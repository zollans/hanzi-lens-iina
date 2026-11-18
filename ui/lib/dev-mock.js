/* Development only: when a page is opened outside IINA (no injected bridge), provide a stand-in
 * `window.iina` that talks to a parent harness page via postMessage. Inside IINA this is inert. */
(function () {
  if (window.iina || window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iina) return;
  window.__HL_MOCK = true;
  window.iina = {
    listeners: {},
    _emit(name, data) {
      const cb = this.listeners[name];
      if (typeof cb === "function") cb(data ? JSON.parse(data) : undefined);
    },
    onMessage(name, cb) { this.listeners[name] = cb; },
    postMessage(name, data) {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ hl: true, page: document.title, name, data: JSON.parse(JSON.stringify(data === undefined ? null : data)) }, "*");
      }
    },
  };
})();
