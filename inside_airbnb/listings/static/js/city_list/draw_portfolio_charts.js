/* Portfolio-size split (listings per host).
 *
 * Reads: <script id="city-hosts-data" type="application/json">{...}</script>
 * Renders into:
 *   #chart-portfolio   — bar chart of hosts bucketed by listing count
 *   #portfolio-badge   — total hosts, shown in the header
 *
 * Requires Observable Plot on window.Plot.
 *
 * Design notes
 * ------------
 * - Bucket order is ordinal ("1", "2", "3–5", …) and is preserved as given.
 * - Counts are printed directly on the bars, so the y-axis is deliberately
 *   light (no ticks, faint grid) — the reader never has to trace back to
 *   the axis to recover a value.
 * - Every bar carries a tooltip with the raw count and its share of hosts,
 *   which is the number people usually want next.
 * - The y domain is padded ~18% so value labels never collide with the
 *   top of the plot.
 * - The chart is exposed as role="img" with an aria-label summarising all
 *   buckets, so screen readers get the full picture without a table.
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- setup */

  const dataEl = document.getElementById("city-hosts-data");
  const mount = document.getElementById("chart-portfolio");
  const badge = document.getElementById("portfolio-badge");
  if (!dataEl || !mount) return;

  if (typeof Plot === "undefined") {
    console.error("portfolio.js: Observable Plot not found on window.Plot");
    return;
  }

  let hosts;
  try {
    hosts = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("portfolio.js: invalid data", err);
    return;
  }
  if (!hosts) return;

  /* ------------------------------------------------------------- normalise */

  const series = hosts.portfolio_split || {};
  const rawLbl = Array.isArray(series.labels) ? series.labels : [];
  const rawVal = Array.isArray(series.values) ? series.values : [];

  const rows = [];
  let total = 0;
  for (let i = 0; i < rawLbl.length; i++) {
    const v = Number(rawVal[i]);
    if (!isFinite(v) || v < 0) continue; // skip junk quietly
    rows.push({ label: String(rawLbl[i]), value: v });
    total += v;
  }

  /* --------------------------------------------------------------- palette */

  const ROSE = "#ff385c";
  const ROSE_SOFT = "#ff8ba0";
  const AXIS = "#dee2e6";
  const GRID = "#eef0f2";
  const TICK = "#6c757d";
  const LABEL = "#343a40";
  const FONT =
    "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  const nf = new Intl.NumberFormat();
  const fmtInt = (v) => nf.format(Math.round(v));

  function fmtY(v) {
    if (v >= 1000) {
      const k = v / 1000;
      return (k % 1 === 0 ? k : k.toFixed(1)) + "k";
    }
    return fmtInt(v);
  }

  function fmtPct(v, tot) {
    if (!tot) return "0%";
    const p = (v / tot) * 100;
    return (p >= 10 ? p.toFixed(0) : p.toFixed(1)) + "%";
  }

  /* ----------------------------------------------------------- header badge */

  if (badge) badge.textContent = total ? fmtInt(total) + " hosts" : "";

  /* ---------------------------------------------------------- empty state */

  if (!rows.length) {
    mount.replaceChildren();
    const span = document.createElement("span");
    span.setAttribute(
      "style",
      "font-size:.7rem;color:#adb5bd;font-style:italic;",
    );
    span.textContent = "No portfolio data";
    mount.appendChild(span);
    return;
  }

  /* ------------------------------------------------------------ a11y summary */

  const summary =
    "Host portfolio sizes: " +
    rows
      .map((r) => r.label + " listings, " + fmtInt(r.value) + " hosts")
      .join("; ") +
    ".";
  mount.setAttribute("role", "img");
  mount.setAttribute("aria-label", summary);

  /* ------------------------------------------------------------- rendering */

  let raf = null;
  let lastW = 0;
  let lastH = 0;

  function draw() {
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    if (w < 40 || h < 40) return;
    if (w === lastW && h === lastH && mount.firstChild) return;
    lastW = w;
    lastH = h;

    mount.replaceChildren();

    const values = rows.map((r) => r.value);
    const max = Math.max.apply(null, values);
    const yMax = max > 0 ? max * 1.18 : 1; // headroom for value labels

    const compact = w < 320;
    const fontSize = compact ? 9 : 10;
    const marginLeft = compact ? 26 : 30;
    const marginRight = 8;
    const marginTop = 16; // room for the top value label
    const marginBottom = 22;

    const svg = Plot.plot({
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
        label: "Portfolio",
        domain: rows.map((r) => r.label),
        tickSize: 0,
        tickPadding: 4,
        // Long bucket labels get clipped by Plot; keep them centred.
        tickRotate: 0,
      },
      y: {
        label: null,
        domain: [0, yMax],
        nice: true, // round the top to a friendly number
        ticks: 3,
        tickSize: 0,
        tickPadding: 3,
        tickFormat: fmtY,
        grid: true,
        gridStroke: GRID,
        gridStrokeWidth: 1,
      },
      marks: [
        // Zero baseline — dark enough to read as the axis, not as data.
        Plot.ruleY([0], { stroke: AXIS, strokeWidth: 1 }),

        // Bars
        Plot.barY(rows, {
          x: "label",
          y: "value",
          fill: ROSE_SOFT,
          fillOpacity: 0.9,
          rx: 2,
          title: (d) =>
            d.label +
            " listing" +
            (d.label === "1" ? "" : "s") +
            "\n" +
            fmtInt(d.value) +
            " hosts (" +
            fmtPct(d.value, total) +
            ")",
        }),

        // Value labels, sitting just above each bar.
        Plot.text(rows, {
          x: "label",
          y: "value",
          text: (d) => (d.value > 0 ? fmtInt(d.value) : ""),
          dy: -5,
          fontSize: fontSize - 0.5,
          fontWeight: 500,
          fill: LABEL,
          pointerEvents: "none",
        }),
      ],
    });

    mount.appendChild(svg);
  }

  /* -------------------------------------------------------------- resize */

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = null;
      draw();
    });
  }

  if ("ResizeObserver" in window) {
    try {
      new ResizeObserver(schedule).observe(mount);
    } catch (e) {
      window.addEventListener("resize", schedule);
    }
  } else {
    window.addEventListener("resize", schedule);
  }

  schedule();
})();
