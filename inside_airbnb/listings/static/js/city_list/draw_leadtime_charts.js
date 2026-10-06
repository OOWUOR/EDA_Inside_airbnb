/* Booking lead-time histogram — with compact value labels on top of bars.
 *
 * Reads: <script id="city-stats-data" type="application/json">{...}</script>
 * Renders into:
 *   #chart-lead-time   — histogram of days between scrape and check-in
 *   #lead-time-badge   — median lead time, shown in the header
 *
 * Requires Observable Plot on window.Plot.
 *
 * Value labels
 * ------------
 * Counts are drawn just above each bar in a shortened form:
 *     950  →  "950"
 *     1234 →  "1.2k"
 *     12000 → "12k"
 *     1234567 → "1.2M"
 *
 * The y-domain is padded so the tallest label always has room. When bars
 * get too narrow for every label, labels are thinned by stride — but the
 * peak bar is always labelled, since it is the one the reader needs most.
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

  const hist = stats.lead_time_hist || {};
  const rawLbl = Array.isArray(hist.labels) ? hist.labels : [];
  const rawVal = Array.isArray(hist.values) ? hist.values : [];

  const rows = [];
  let total = 0;
  for (let i = 0; i < rawLbl.length; i++) {
    const v = Number(rawVal[i]);
    if (!isFinite(v) || v < 0) continue;
    rows.push({ label: String(rawLbl[i]), value: v });
    total += v;
  }

  console.debug(LOG, "parsed", {
    bins: rows.length,
    total: total,
    mountW: mount.clientWidth,
    mountH: mount.clientHeight,
    plotVersion: (Plot && Plot.version) || "unknown",
  });

  /* --------------------------------------------------------------- palette */

  const ROSE = "#ff385c";
  const AXIS = "#dee2e6";
  const GRID = "#f1f3f5";
  const TICK = "#6c757d";
  const LABEL = "#868e96";
  const VALUE = "#343a40";
  const FONT =
    "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  /* ---------------------------------------------------- number formatters */

  const nfInt = new Intl.NumberFormat();

  /* Short form used for the labels above the bars: "950", "1.2k", "12k",
     "1.2M". One decimal only when it adds information. */
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
    if (a >= 1e4) return Math.round(v / 1e3) + "k";
    if (a >= 1e3) {
      const k = Math.round(v / 100) / 10;
      return (k % 1 === 0 ? k : k.toFixed(1)) + "k";
    }
    return String(Math.round(v));
  }

  /* Longer form used for axis ticks and tooltips. */
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

  function niceTicks(min, max, target) {
    if (!(max > min) || !isFinite(min) || !isFinite(max)) return [min];
    const raw = (max - min) / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    const i0 = Math.ceil(min / step - 1e-9);
    const i1 = Math.floor(max / step + 1e-9);
    for (let i = i0; i <= i1; i++) out.push(i * step);
    return out;
  }

  /* ----------------------------------------------------------- header badge */

  if (badge) {
    const med = Number(stats.median_lead_days);
    badge.textContent = isFinite(med)
      ? "median " + (med >= 10 ? Math.round(med) : med.toFixed(1)) + "d"
      : "";
  }

  /* ---------------------------------------------------------- empty state */

  if (!rows.length) {
    showMessage("No lead-time data");
    return;
  }

  /* ------------------------------------------------------------ a11y summary */

  let peak = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].value > peak.value) peak = rows[i];
  }
  const medVal = Number(stats.median_lead_days);
  mount.setAttribute("role", "img");
  mount.setAttribute(
    "aria-label",
    "Lead-time distribution across " +
      nfInt.format(total) +
      " listings" +
      (isFinite(medVal) ? ", median " + medVal + " days" : "") +
      ". Peak bin: " +
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

  /* Safe single-datum text annotation. */
  function annotation(text, opts) {
    return Plot.text(
      [0],
      Object.assign(
        {
          text: () => text,
          pointerEvents: "none",
        },
        opts || {},
      ),
    );
  }

  function buildSpec(w, h) {
    const values = rows.map((r) => r.value);
    const max = Math.max.apply(null, values);
    if (!(max > 0)) return null;

    const tiny = w < 160 || h < 90;
    const narrow = w < 260;
    const fontSize = tiny ? 8 : narrow ? 9 : 10;
    const valueFont = tiny ? 7 : narrow ? 8 : 9;

    /* ---- y scale with label headroom ------------------------------- *
     * Extra 20% above max so the value label on the tallest bar sits
     * well clear of the plot top edge. No label clipping. */
    const domainTop = max * 1.2;

    const showYAxis = !tiny;
    const ticks = showYAxis
      ? niceTicks(0, domainTop, 2).filter((v) => v > 0 && v <= domainTop)
      : [];
    const yTickSet = new Set(ticks);

    /* ---- margins --------------------------------------------------- */

    const marginTop = tiny ? 10 : 14; // room for the top label
    const marginRight = tiny ? 4 : 6;
    const marginLeft = showYAxis ? (narrow ? 24 : 30) : 2;

    const maxLabelLen = rows.reduce((s, r) => Math.max(s, r.label.length), 0);
    const rotate = rows.length > 4 || maxLabelLen > 4 || narrow;
    const labelSpace = rotate
      ? Math.min(34, 12 + maxLabelLen * fontSize * 0.55)
      : fontSize + 4;

    const showXTitle = !tiny;
    const marginBottom = labelSpace + (showXTitle ? 2 : 0) + 4;

    /* ---- x-tick thinning ------------------------------------------- */

    const perLabel = Math.max(18, fontSize * 2.6);
    const plotW = Math.max(1, w - marginLeft - marginRight);
    const stride = Math.max(1, Math.ceil((rows.length * perLabel) / plotW));
    const tickSet = new Set();
    for (let i = 0; i < rows.length; i += stride) tickSet.add(rows[i].label);

    /* ---- value-label thinning -------------------------------------- *
     * Show every label when bars are wide enough; otherwise thin by
     * stride. The peak bar is always labelled. */
    const perBar = plotW / rows.length;
    const labelOK = perBar >= 14 || rows.length <= 8;
    const labelStride = labelOK ? 1 : Math.max(1, Math.ceil(14 / perBar));
    const peakIdx = rows.indexOf(peak);

    const labeledRows = rows.filter(
      (d, i) => d.value > 0 && (i % labelStride === 0 || i === peakIdx),
    );

    /* ---- marks ----------------------------------------------------- */

    const marks = [
      Plot.ruleY([0], { stroke: AXIS, strokeWidth: 1 }),

      Plot.barY(rows, {
        x: "label",
        y: "value",
        fill: ROSE,
        fillOpacity: 0.85,
        title: (d) =>
          d.label +
          "\n" +
          nfInt.format(d.value) +
          " listings (" +
          fmtPct(d.value, total) +
          ")",
      }),
    ];

    /* Value labels on top of bars, shortened. */
    if (labeledRows.length) {
      marks.push(
        Plot.text(labeledRows, {
          x: "label",
          y: "value",
          text: (d) => fmtShort(d.value),
          dy: -4,
          fontSize: valueFont,
          fontWeight: 600,
          fill: VALUE,
          pointerEvents: "none",
        }),
      );
    }

    if (showXTitle) {
      marks.push(
        annotation("days", {
          frameAnchor: "bottom-right",
          dx: -marginRight,
          dy: -1,
          fontSize: fontSize,
          fontStyle: "italic",
          fill: LABEL,
        }),
      );
    }

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
        label: null,
        domain: rows.map((r) => r.label),
        tickSize: 0,
        tickPadding: 2,
        tickRotate: rotate ? -40 : 0,
        tickAnchor: rotate ? "end" : "middle",
        tickFormat: (v) => (tickSet.has(v) ? String(v) : ""),
      },
      y: {
        label: null,
        domain: [0, domainTop],
        ticks: ticks,
        tickFormat: (v) => (yTickSet.has(v) ? fmtY(v) : ""),
        tickSize: 0,
        tickPadding: 2,
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
    const labeledRows = rows.filter((d) => d.value > 0);
    return {
      width: w,
      height: h,
      marginTop: 14,
      marginRight: 6,
      marginBottom: 24,
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
        tickRotate: -35,
        tickSize: 0,
        tickPadding: 2,
      },
      y: {
        domain: [0, max * 1.2],
        ticks: 2,
        tickSize: 0,
        tickPadding: 2,
        grid: true,
        gridStroke: GRID,
        gridStrokeWidth: 1,
      },
      marks: [
        Plot.ruleY([0], { stroke: AXIS, strokeWidth: 1 }),
        Plot.barY(rows, {
          x: "label",
          y: "value",
          fill: ROSE,
          fillOpacity: 0.85,
        }),
        Plot.text(labeledRows, {
          x: "label",
          y: "value",
          text: (d) => fmtShort(d.value),
          dy: -4,
          fontSize: 8,
          fontWeight: 600,
          fill: VALUE,
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
      console.debug(LOG, "rendered (rich)", { w: w, h: h, bins: rows.length });
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
