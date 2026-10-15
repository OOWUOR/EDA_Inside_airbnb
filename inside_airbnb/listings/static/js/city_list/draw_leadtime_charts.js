/* Bar plot — lead-time grouped into 4 brackets.
 *
 * Reads: <script id="city-stats-data" type="application/json">{...}</script>
 *   stats.lead_time_buckets — {labels:[…], values:[…]}  (4 buckets)
 *   stats.median_lead_days  — number, computed server-side
 * Renders into:
 *   #chart-lead-time   — 4 bars (0d, 1–7d, 8–30d, 31+d)
 *   #lead-time-badge   — median lead time, shown in the header
 *
 * Requires Observable Plot on window.Plot.
 *
 * Buckets
 * -------
 *   0     — same-day check-in
 *   1–7   — within a week
 *   8–30  — within a month
 *   31+   — a month or more
 *
 * Styling matches portfolio.js: soft rose bars, rounded corners, tight
 * gaps between bars, light y-axis, value labels above bars.
 */
(function () {
  "use strict";

  const LOG = "[lead_time.js]";

  /* ---------------------------------------------------------------- setup */

  const dataEl = document.getElementById("city-stats-data");
  const mount = document.getElementById("chart-lead-time");
  const badge = document.getElementById("lead-time-badge");

  if (!dataEl) {
    console.warn(LOG, "no #city-stats-data element");
    return;
  }
  if (!mount) {
    console.warn(LOG, "no #chart-lead-time element");
    return;
  }

  function showMessage(text) {
    mount.replaceChildren();
    const span = document.createElement("span");
    span.setAttribute(
      "style",
      "font-size:.7rem;color:#adb5bd;font-style:italic;",
    );
    span.textContent = text;
    mount.appendChild(span);
  }

  if (typeof Plot === "undefined" || !Plot.plot) {
    console.error(LOG, "Observable Plot not loaded on window.Plot");
    showMessage("Chart library not loaded");
    return;
  }

  let stats;
  try {
    stats = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error(LOG, "invalid JSON in #city-stats-data", err);
    showMessage("Invalid data");
    return;
  }
  if (!stats) {
    showMessage("No lead-time data");
    return;
  }

  /* ------------------------------------------------------------- normalise */

  const bt = stats.lead_time_buckets || {};
  const labels = Array.isArray(bt.labels) ? bt.labels : [];
  const values = Array.isArray(bt.values) ? bt.values : [];

  const rows = [];
  let total = 0;
  for (let i = 0; i < labels.length; i++) {
    const v = Number(values[i]);
    const n = isFinite(v) && v > 0 ? v : 0;
    rows.push({ label: String(labels[i]), value: n });
    total += n;
  }

  const medianLead = Number(stats.median_lead_days);

  console.debug(LOG, "parsed", {
    n: total,
    median: medianLead,
    buckets: rows.map((r) => r.label + "=" + r.value),
    mountW: mount.clientWidth,
    mountH: mount.clientHeight,
    plotVersion: (Plot && Plot.version) || "unknown",
  });

  /* --------------------------------------------------------------- palette */

  const ROSE = "#ff385c";
  const ROSE_SOFT = "#ff8ba0";
  const AXIS = "#dee2e6";
  const GRID = "#eef0f2";
  const TICK = "#6c757d";
  const LABEL = "#343a40";
  const FONT =
    "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  /* ---------------------------------------------------- number formatters */

  const nfInt = new Intl.NumberFormat();

  function fmtShort(v) {
    const a = Math.abs(v);
    if (a >= 1e6) {
      const m = v / 1e6;
      return (
        ((Math.round(m * 10) / 10) % 1 === 0
          ? Math.round(m)
          : Math.round(m * 10) / 10) + "M"
      );
    }
    /*if (a >= 1e4) return Math.round(v / 1e3) + "k";
    if (a >= 1e3) {
      const k = Math.round(v / 100) / 10;
      return (k % 1 === 0 ? k : k.toFixed(1)) + "k";
    }*/
    return String(Math.round(v));
  }

  function fmtY(v) {
    if (v >= 1e6) {
      const m = v / 1e6;
      return (m % 1 === 0 ? m : m.toFixed(1)) + "M";
    }
    if (v >= 1e4) return Math.round(v / 1e3) + "k";
    if (v >= 1e3) {
      const k = v / 1e3;
      return (k % 1 === 0 ? k : k.toFixed(1)) + "k";
    }
    return nfInt.format(Math.round(v));
  }

  function fmtPct(v, tot) {
    if (!tot) return "0%";
    const p = (v / tot) * 100;
    return (p >= 10 ? p.toFixed(0) : p.toFixed(1)) + "%";
  }

  /* ----------------------------------------------------------- header badge */

  if (badge) {
    badge.textContent = isFinite(medianLead)
      ? "median " +
        (medianLead >= 10 ? Math.round(medianLead) : medianLead.toFixed(1)) +
        "d"
      : "";
  }

  /* ---------------------------------------------------------- empty state */

  const anyValue = rows.some((r) => r.value > 0);
  if (!anyValue) {
    showMessage("No lead-time data");
    return;
  }

  /* ------------------------------------------------------------ a11y summary */

  let peak = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].value > peak.value) peak = rows[i];
  }
  mount.setAttribute("role", "img");
  mount.setAttribute(
    "aria-label",
    "Lead-time distribution across " +
      nfInt.format(total) +
      " listings" +
      (isFinite(medianLead) ? ", median " + medianLead + " days" : "") +
      ". Largest bracket: " +
      peak.label +
      " (" +
      nfInt.format(peak.value) +
      " listings).",
  );

  /* ============================================================== size ==== */

  const MIN_H = 120;

  function resolveSize() {
    let w = mount.clientWidth;
    let h = mount.clientHeight;

    if (w < 60) {
      const p = mount.parentElement;
      if (p && p.clientWidth > w) w = p.clientWidth;
    }
    if (h < 40) {
      const p = mount.parentElement;
      if (p && p.clientHeight > h) h = p.clientHeight;
    }
    if (h < 40 && w >= 60) {
      mount.style.minHeight = MIN_H + "px";
      void mount.offsetHeight;
      h = mount.clientHeight || MIN_H;
    }
    return { w: w, h: h };
  }

  /* =========================================================== rendering == */

  let raf = null;
  let lastW = 0;
  let lastH = 0;
  let rendered = false;

  function buildSpec(w, h) {
    const values = rows.map((r) => r.value);
    const max = Math.max.apply(null, values);
    if (!(max > 0)) return null;

    const compact = w < 320;
    const tiny = w < 160 || h < 90;
    const fontSize = tiny ? 8 : compact ? 9 : 10;

    const showYAxis = !tiny;

    /* ---- margins --------------------------------------------------- */

    const marginTop = tiny ? 12 : 16;    // room for top value label
    const marginRight = 8;
    const marginLeft = showYAxis ? (compact ? 26 : 30) : 4;
    const marginBottom = 22;

    /* ---- marks ----------------------------------------------------- */

    const marks = [
      // Zero baseline
      Plot.ruleY([0], { stroke: AXIS, strokeWidth: 1 }),

      // Bars — soft rose, rounded corners, tight gaps
      Plot.barY(rows, {
        x: "label",
        y: "value",
        fill: ROSE_SOFT,
        fillOpacity: 0.9,
        rx: 2,
        title: (d) =>
          d.label +
          "\n" +
          nfInt.format(d.value) +
          " listings (" +
          fmtPct(d.value, total) +
          ")",
      }),

      // Value labels above bars
      Plot.text(rows, {
        x: "label",
        y: "value",
        text: (d) => (d.value > 0 ? fmtShort(d.value) : ""),
        dy: -5,
        fontSize: fontSize - 0.5,
        fontWeight: 500,
        fill: LABEL,
        pointerEvents: "none",
      }),
    ];

    return {
      width: w,
      height: h,
      marginTop: marginTop,
      marginRight: marginRight,
      marginBottom: marginBottom,
      marginLeft: marginLeft,
      style: {
        fontSize: fontSize + "px",
        fontFamily: FONT,
        background: "transparent",
        color: TICK,
        overflow: "visible",
      },
      x: {
        label: "Days",
        domain: rows.map((r) => r.label),
        padding: 0.1,   // match portfolio.js — tight gaps between bars
        tickSize: 0,
        tickPadding: 4,
      },
      y: {
        label: "n_bookings",
        domain: [0, max * 1.18],   // headroom for value labels
        nice: true,                // round the top to a friendly number
        ticks: showYAxis ? 3 : 0,
        tickFormat: showYAxis ? fmtY : () => "",
        tickSize: 0,
        tickPadding: 3,
        grid: showYAxis,
        gridStroke: GRID,
        gridStrokeWidth: 1,
      },
      marks: marks,
    };
  }

  /* Bare-bones fallback (bars + labels, no frills). */
  function minimalSpec(w, h) {
    const max =
      Math.max.apply(
        null,
        rows.map((r) => r.value),
      ) || 1;
    return {
      width: w,
      height: h,
      marginTop: 16,
      marginRight: 8,
      marginBottom: 22,
      marginLeft: 28,
      style: {
        fontSize: "9px",
        fontFamily: FONT,
        background: "transparent",
        color: TICK,
        overflow: "visible",
      },
      x: {
        domain: rows.map((r) => r.label),
        padding: 0.1,
        tickSize: 0,
        tickPadding: 4,
      },
      y: {
        domain: [0, max * 1.18],
        nice: true,
        ticks: 3,
        tickFormat: fmtY,
        tickSize: 0,
        tickPadding: 3,
        grid: true,
        gridStroke: GRID,
        gridStrokeWidth: 1,
      },
      marks: [
        Plot.ruleY([0], { stroke: AXIS, strokeWidth: 1 }),
        Plot.barY(rows, {
          x: "label",
          y: "value",
          fill: ROSE_SOFT,
          fillOpacity: 0.9,
          rx: 2,
        }),
        Plot.text(rows, {
          x: "label",
          y: "value",
          text: (d) => (d.value > 0 ? fmtShort(d.value) : ""),
          dy: -5,
          fontSize: 9,
          fontWeight: 500,
          fill: LABEL,
          pointerEvents: "none",
        }),
      ],
    };
  }

  function draw() {
    const size = resolveSize();
    const w = size.w;
    const h = size.h;

    if (w < 60 || h < 40) {
      console.debug(LOG, "draw skipped — still no size", { w: w, h: h });
      return false;
    }
    if (rendered && w === lastW && h === lastH && mount.firstChild) {
      return true;
    }
    lastW = w;
    lastH = h;

    mount.replaceChildren();

    try {
      const spec = buildSpec(w, h);
      if (!spec) {
        showMessage("No lead-time data");
        return true;
      }
      const svg = Plot.plot(spec);
      mount.appendChild(svg);
      rendered = true;
      console.debug(LOG, "rendered (rich)", { w: w, h: h, bars: rows.length });
      return true;
    } catch (err) {
      console.error(LOG, "rich Plot.plot threw — falling back", err);
      if (err && err.message) console.error(LOG, "error message:", err.message);
      if (err && err.stack) console.error(LOG, "stack:", err.stack);
    }

    mount.replaceChildren();
    try {
      const svg = Plot.plot(minimalSpec(w, h));
      mount.appendChild(svg);
      rendered = true;
      console.warn(
        LOG,
        "rendered (minimal fallback). Check the rich error above.",
      );
      return true;
    } catch (err2) {
      console.error(LOG, "minimal Plot.plot also threw", err2);
      showMessage("Chart failed to render — see console");
      return false;
    }
  }

  /* ------------------------------------------------------------- schedule */

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = null;
      draw();
    });
  }

  let attempts = 0;
  const MAX_ATTEMPTS = 24;
  function tryInitialRender() {
    if (rendered) return;
    attempts++;
    const ok = draw();
    if (ok) return;
    if (attempts >= MAX_ATTEMPTS) {
      console.warn(
        LOG,
        "gave up after " + attempts + " attempts; mount still has no size",
        { w: mount.clientWidth, h: mount.clientHeight },
      );
      return;
    }
    setTimeout(tryInitialRender, 150);
  }

  function observe(el) {
    if (!el || !("ResizeObserver" in window)) return;
    try {
      new ResizeObserver(schedule).observe(el);
    } catch (e) {
      /* ignore */
    }
  }
  observe(mount);
  observe(mount.parentElement);

  if (!("ResizeObserver" in window)) {
    window.addEventListener("resize", schedule);
  }

  if ("IntersectionObserver" in window) {
    try {
      const io = new IntersectionObserver(
        function (entries) {
          for (let i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) {
              schedule();
              if (rendered) io.disconnect();
            }
          }
        },
        { rootMargin: "50px" },
      );
      io.observe(mount);
    } catch (e) {
      /* ignore */
    }
  }

  schedule();
  tryInitialRender();
})();