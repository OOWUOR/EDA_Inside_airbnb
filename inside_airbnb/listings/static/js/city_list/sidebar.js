/* Sidebar collapse toggle.
 *
 * Persists state in localStorage.  On mobile the sidebar overlays the
 * content and auto-closes when a city is picked or Escape is pressed.
 */
(function () {
  "use strict";

  const app = document.querySelector(".app");
  const btn = document.getElementById("sidebar-toggle");
  const scrim = document.getElementById("sidebar-scrim");
  if (!app || !btn) return;

  const STORAGE_KEY = "sidebar-collapsed";
  const MOBILE_Q = window.matchMedia("(max-width: 760px)");

  function isMobile() {
    return MOBILE_Q.matches;
  }

  function setCollapsed(collapsed, { persist = true } = {}) {
    app.classList.toggle("is-collapsed", collapsed);
    btn.setAttribute("aria-expanded", String(!collapsed));
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, String(collapsed));
      } catch (_) {}
    }
  }

  function isCollapsed() {
    return app.classList.contains("is-collapsed");
  }

  /* -- initial state --------------------------------------------- */

  let initial;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    initial = stored === null ? isMobile() : stored === "true";
  } catch (_) {
    initial = isMobile();
  }
  setCollapsed(initial, { persist: false });

  /* -- toggle ---------------------------------------------------- */

  btn.addEventListener("click", () => {
    setCollapsed(!isCollapsed());
  });

  /* -- click outside / scrim closes on mobile -------------------- */

  scrim?.addEventListener("click", () => {
    if (isMobile()) setCollapsed(true);
  });

  /* -- Escape closes on mobile ----------------------------------- */

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isMobile() && !isCollapsed()) {
      setCollapsed(true);
    }
  });

  /* -- picking a city closes the sidebar on mobile --------------- */

  document.addEventListener("click", (e) => {
    if (!isMobile()) return;
    if (e.target.closest(".city-list a")) setCollapsed(true);
  });

  /* -- react to viewport crossing the breakpoint ----------------- */

  MOBILE_Q.addEventListener("change", (e) => {
    // On crossing into mobile, close by default so content is visible.
    // On crossing back to desktop, respect the stored preference.
    if (e.matches) {
      setCollapsed(true, { persist: false });
    } else {
      let stored = "false";
      try {
        stored = localStorage.getItem(STORAGE_KEY) ?? "false";
      } catch (_) {}
      setCollapsed(stored === "true", { persist: false });
    }
  });
})();

// in sidebar.js
document.addEventListener("click", (e) => {
  const link = e.target.closest('a[href^="?"]');
  if (!link || !document.startViewTransition) return;
  e.preventDefault();
  document.startViewTransition(() => {
    window.location.href = link.href;
  });
});
