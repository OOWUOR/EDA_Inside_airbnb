/* Mini-box tooltips.
 *
 * Attaches a small styled tooltip to each .mini-box in the snapshot
 * grid.  Explains the box-plot shape on hover or focus without
 * occupying permanent UI space.
 *
 * Copy is written so a first-time reader gets the four elements —
 * box, notch, whiskers, spread — in one sentence, then a second line
 * applies them to the actual numbers for that cell.
 */
(function () {
  "use strict";

  const LOG = "[box_tooltips.js]";

  /* ----------------------------------------------------------- sources */

  const dataEl = document.getElementById("city-stats-data");
  if (!dataEl) return;

  let stats;
  try { stats = JSON.parse(dataEl.textContent); }
  catch (err) { console.error(LOG, "invalid JSON", err); return; }
  if (!stats) return;

  /* ---------------------------------------------------------- cell config */

  /* Each entry maps a mount id to its stat key, a human label, and the
     unit that should be appended to numbers ("n", "%", ""). */
  const CELLS = [
    { id: "box-nights",     key: "box_nights",     label: "Avg nights",  unit: "n" },
    { id: "box-occupancy",  key: "box_occupancy",  label: "Occupancy",   unit: "%" },
    { id: "box-multi-host", key: "box_multi_host", label: "Multi-host",  unit: "" },
  ];

  /* --------------------------------------------------------- formatting */

  function fmt(v, unit) {
    if (v == null || !isFinite(v)) return "—";
    /* Keep one decimal only when the value isn't whole. */
    const s = Math.abs(v - Math.round(v)) < 0.05
      ? String(Math.round(v))
      : v.toFixed(1);
    return s + (unit || "");
  }

  /* Two-line tooltip: how to read a box plot, then this cell's numbers. */
  function tooltipHTML(cell, box) {
    const howto =
      "<strong>How to read this</strong><br>" +
      "The box is the middle 50% of listings (Q1 – Q3). " +
      "The notch is the median. " +
      "Whisker tips are the lowest and highest values after excluding outliers. " +
      "A wider box means listings vary more.";

    const numbers =
      "<span class=\"box-tip-range\">" +
        "Median <b>" + fmt(box.median, cell.unit) + "</b> · " +
        "middle half <b>" + fmt(box.q1, cell.unit) + " – " + fmt(box.q3, cell.unit) + "</b> · " +
        "range <b>" + fmt(box.min, cell.unit) + " – " + fmt(box.max, cell.unit) + "</b>" +
      "</span>";

    return howto + "<hr>" + numbers;
  }

  /* Plain-text version for aria-label. */
  function ariaText(cell, box) {
    return (
      cell.label + " distribution. " +
      "Median " + fmt(box.median, cell.unit) + ", " +
      "middle half " + fmt(box.q1, cell.unit) + " to " + fmt(box.q3, cell.unit) + ", " +
      "range " + fmt(box.min, cell.unit) + " to " + fmt(box.max, cell.unit) + "."
    );
  }

  /* ----------------------------------------------------------- tooltip */

  const tip = document.createElement("div");
  tip.className = "box-tip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);

  let showTimer = null;

  function show(target, html) {
    tip.innerHTML = html;
    tip.setAttribute("aria-hidden", "false");
    tip.classList.add("is-visible");
    position(target);
  }

  function position(target) {
    const r = target.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();

    /* Prefer below the box; flip above if it would overflow the viewport. */
    let top = r.bottom + 8;
    let flipped = false;
    if (top + tr.height > window.innerHeight - 8) {
      top = r.top - tr.height - 8;
      flipped = true;
    }

    /* Centre horizontally, clamp to viewport. */
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));

    tip.style.top = Math.round(top) + "px";
    tip.style.left = Math.round(left) + "px";
    tip.classList.toggle("is-flipped", flipped);
    /* Store reference to the anchor so we can flip the arrow. */
    tip.style.setProperty("--anchor-x",
      Math.round(r.left + r.width / 2 - left) + "px");
  }

  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    tip.classList.remove("is-visible");
    tip.setAttribute("aria-hidden", "true");
  }

  /* ------------------------------------------------------------ wiring */

  let wired = 0;

  CELLS.forEach((cell) => {
    const el = document.getElementById(cell.id);
    if (!el) { console.warn(LOG, "missing #" + cell.id); return; }

    const box = stats[cell.key];
    if (!box || box.min == null || box.max == null) return;

    const html = tooltipHTML(cell, box);
    const aria = ariaText(cell, box);

    /* Keyboard focusability + screen-reader label. */
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", aria);

    /* Mouse: small open delay so quick passes don't flicker the tip. */
    el.addEventListener("mouseenter", () => {
      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => { show(el, html); showTimer = null; }, 80);
    });
    el.addEventListener("mouseleave", hide);

    /* Keyboard: instant, no delay. */
    el.addEventListener("focus",  () => show(el, html));
    el.addEventListener("blur",   hide);

    /* Touch: tap toggles, tap elsewhere closes. */
    el.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      if (tip.classList.contains("is-visible")) hide();
      else show(el, html);
    }, { passive: true });

    wired++;
  });

  /* Close on scroll, resize, Escape, or any click outside a mini-box. */
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".mini-box")) hide();
  });

  console.debug(LOG, "wired", wired, "of", CELLS.length);
})();