/* Snapshot mini box plots.
 *
 * Renders one small horizontal box plot in each of the three snapshot
 * cards that carry a distribution:
 *
 *   #box-nights       ← city_stats.box_nights
 *   #box-occupancy    ← city_stats.box_occupancy
 *   #box-multi-host   ← city_stats.box_multi_host
 *
 * Reads: <script id="city-stats-data" type="application/json">{...}</script>
 * Requires: window.drawBoxPlots from boxes.js
 *
 * Each box carries {min, q1, median, q3, max}.  The cards are small, so
 * the renderer is invoked in compact mode (no label gutter, no axis) and
 * the cards carry the numeric headline themselves — the box plot's job
 * is to show spread, not to repeat the number.
 *
 * Robustness notes
 * ----------------
 * Mini cells inside snapshot cards frequently report clientHeight = 0 at
 * first paint (flex/grid layout, late CSS, dashboard animating in).  The
 * pattern here mirrors lead_time.js: resolve a usable size, force a
 * min-height if needed, retry on a short timer, and observe both the
 * mount and its parent.
 */
(function () {
  "use strict";

  const LOG = "[snapshot_boxes.js]";

  /* ---------------------------------------------------------------- setup */

  const dataEl = document.getElementById("city-stats-data");
  if (!dataEl) {
    console.warn(LOG, "no #city-stats-data element");
    return;
  }

  if (typeof window.drawBoxPlots !== "function") {
    console.error(LOG, "window.drawBoxPlots not found — is boxes.js loaded?");
    return;
  }

  let stats;
  try {
    stats = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error(LOG, "invalid JSON", err);
    return;
  }
  if (!stats) return;

  /* ---------------------------------------------------------- cell config */

  /* One entry per mini card.  `dim` is empty because the card header
     already names the metric; the compact renderer won't draw it. */
  const CELLS = [
    { id: "box-nights", key: "box_nights" },
    { id: "box-occupancy", key: "box_occupancy" },
    { id: "box-multi-host", key: "box_multi_host" },
  ];

  /* Minimum height to force on the mount when it reports 0 (flex/grid
     cells with no explicit height).  28px is enough for one box row
     plus a small breathing margin. */
  const MIN_H = 28;

  /* --------------------------------------------------------------- helpers */

  function mountFor(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    return el;
  }

  function ensureSize(el) {
    let w = el.clientWidth;
    let h = el.clientHeight;

    if (w < 20) {
      const p = el.parentElement;
      if (p && p.clientWidth > w) w = p.clientWidth;
    }
    if (h < 12) {
      const p = el.parentElement;
      if (p && p.clientHeight > h) h = p.clientHeight;
    }
    if (h < 12 && w >= 20) {
      el.style.minHeight = MIN_H + "px";
      // force reflow so clientHeight reflects the new min-height
      void el.offsetHeight;
      h = el.clientHeight || MIN_H;
    }
    return { w: w, h: h };
  }

  /* ----------------------------------------------------------- per-cell render */

  function makeRenderer(el, box) {
    let lastW = 0;
    let lastH = 0;
    let rendered = false;

    function draw() {
      const { w, h } = ensureSize(el);

      if (w < 20 || h < 12) return false;
      if (rendered && w === lastW && h === lastH && el.firstChild) return true;

      lastW = w;
      lastH = h;

      try {
        /* The compact renderer takes a list of boxes; we pass one.
           `dim` is deliberately blank — the compact mode skips the
           label gutter entirely so it costs nothing. */
        window.drawBoxPlots(el, [box], { compact: true, digits: 1 });
        rendered = true;
        return true;
      } catch (err) {
        console.error(LOG, "drawBoxPlots failed for #" + el.id, err);
        el.replaceChildren();
        const span = document.createElement("span");
        span.setAttribute(
          "style",
          "font-size:.65rem;color:#adb5bd;font-style:italic;",
        );
        span.textContent = "—";
        el.appendChild(span);
        rendered = true;
        return true;
      }
    }

    return draw;
  }

  /* ------------------------------------------------------------ lifecycle */

  const renderers = [];

  CELLS.forEach((cell) => {
    const el = mountFor(cell.id);
    if (!el) {
      console.warn(LOG, "missing #" + cell.id);
      return;
    }

    const box = stats[cell.key];
    if (!box || box.min == null || box.max == null) {
      /* No distribution for this metric (e.g. some columns missing in
         the source CSV for this city).  Leave the card clean. */
      el.replaceChildren();
      return;
    }

    const draw = makeRenderer(el, box);
    renderers.push(draw);

    /* First paint: try immediately, then retry until it lands. */
    let attempts = 0;
    const MAX_ATTEMPTS = 12; // ~1.8s at 150ms
    (function tryDraw() {
      if (draw()) return;
      if (++attempts >= MAX_ATTEMPTS) {
        console.warn(LOG, "gave up on #" + el.id, {
          w: el.clientWidth,
          h: el.clientHeight,
        });
        return;
      }
      setTimeout(tryDraw, 150);
    })();

    /* Observe both the mount and its parent — the parent's size is
       what usually changes when the snapshot grid settles. */
    if ("ResizeObserver" in window) {
      try {
        const ro = new ResizeObserver(() => draw());
        ro.observe(el);
        if (el.parentElement) ro.observe(el.parentElement);
      } catch (e) {
        /* ignore */
      }
    }
  });

  /* Fallback / global resize. */
  let raf = null;
  function scheduleAll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      for (let i = 0; i < renderers.length; i++) renderers[i]();
    });
  }

  if (!("ResizeObserver" in window)) {
    window.addEventListener("resize", scheduleAll);
  }

  /* Re-render when the element first becomes visible (dashboard may have
     been hidden behind a collapsed accordion or off-screen tab). */
  if ("IntersectionObserver" in window) {
    try {
      const io = new IntersectionObserver(
        (entries) => {
          let anyVisible = false;
          for (let i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) anyVisible = true;
          }
          if (anyVisible) scheduleAll();
        },
        { rootMargin: "40px" },
      );
      CELLS.forEach((cell) => {
        const el = document.getElementById(cell.id);
        if (el) io.observe(el);
      });
    } catch (e) {
      /* ignore */
    }
  }

  console.debug(LOG, "initialised", {
    cells: renderers.length,
    nights: stats.box_nights || null,
    occupancy: stats.box_occupancy || null,
    multi_host: stats.box_multi_host || null,
  });
})();

const COPY = {
  "box-nights":
    "Box = middle 50% of listings (Q1–Q3). Line = median. Whiskers = min / max after excluding outliers.",
  "box-occupancy":
    "Box = middle 50% of listings (Q1–Q3). Line = median. Whiskers = min / max after excluding outliers.",
  "box-multi-host":
    "Box = middle 50% of listings per host (Q1–Q3). Line = median. Whiskers = min / max after excluding outliers.",
};

// in the CELLS loop, after mounting:
el.setAttribute("title", COPY[cell.id] || "");
el.setAttribute(
  "aria-label",
  cell.key === "box_nights"
    ? `Median ${box.median} nights, middle half ${box.q1}–${box.q3}, range ${box.min}–${box.max}.`
    : `Median ${box.median}, middle half ${box.q1}–${box.q3}, range ${box.min}–${box.max}.`,
);
