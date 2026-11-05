// Appearance: follow system / light / dark. The choice is stored in the browser (each device keeps its own), and runs as early as possible in <head> to avoid a flash.
// Inside Kiki.app it also tells the native window, so the title bar follows along.
(function () {
  var KEY = "kiki.theme";
  function get() {
    try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch (e) { return "system"; }
  }
  function apply(v) {
    var root = document.documentElement;
    if (v === "light" || v === "dark") root.setAttribute("data-theme", v); else root.removeAttribute("data-theme");
    try { window.webkit.messageHandlers.kikiTheme.postMessage(v); } catch (e) {}
  }
  window.kikiTheme = {
    get: get,
    set: function (v) {
      try { if (v === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) {}
      apply(get());
      window.dispatchEvent(new CustomEvent("kiki-theme", { detail: get() }));
    },
  };
  apply(get());
  // If another page (e.g. inside the settings dialog) changes it, follow along here too
  window.addEventListener("storage", function (e) { if (e.key === KEY || e.key === null) apply(get()); });
})();
