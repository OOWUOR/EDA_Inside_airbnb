/* Listings accordion charts.
 *
 * Reads: <script id="city-charts-data" type="application/json">{...}</script>
 * Mounts into:
 *   #chart-distribution   — histogram + KDE, toggled via [data-toggle-group="dist"]
 *   #chart-room-type      — vertical bar chart
 *   #chart-max-occupants  — vertical bar chart
 *   #chart-property-type  — horizontal bar chart
 *
 * Fix in this revision
 * --------------------
 * The y-scale for the categorical charts previously used
 *     niceTicks(0, maxVal * 1.12, 3)
 * which can return a top tick *below* maxVal (e.g. step=500 → top=500 while
 * maxVal=550), so the tallest bar was clipped at the plot ceiling. The new
 * `yAxisTicks` helper picks the step from a finer 1-1.5-2-2.5-3-4-5-7.5-10
 * ladder and rounds the domain top *up* to the next multiple of the step,
 * guaranteeing ≥8% headroom above the tallest bar — enough for the value
 * label sitting at dy:-4 without touching the plot frame.
 */
(function () {
  "use strict";

  const dataEl = document.getElementById("city-charts-data");
  if (!dataEl || typeof Plot === "undefined") return;

  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("charts.js: invalid data", err);
    return;
  }

  /* ---------------------------------------------------------------- */
  /* Palette and style                                                 */
  /* ---------------------------------------------------------------- */
  const ROSE = "#ff385c";
  const ROSE_SOFT = "#ff8ba0";
  const KDE_STROKE = "#b3003c";
  const RULE_COLOR = "#dddddd";
  const GRID_COLOR = "#f1f3f5";
  const MEDIAN_COLOR = "#212529";
  const VALUE_COLOR = "#343a40";
  const FONT =
    "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  const DIST_XLABEL = {
    price: "Nightly price (USD)",
    revenue: "Revenue (USD)",
    reviews: "Reviews per listing",
    occupancy: "Nights per year",
    host_listings: "Listings per host",
  };

  /* ---------------------------------------------------------------- */
  /* Formatters                                                        */
  /* ---------------------------------------------------------------- */
  const NF = new Intl.NumberFormat();
  const fmtInt = (v) => NF.format(Math.round(v));

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

  /* 1-1.5-2-2.5-3-4-5-7.5-10 ladder — the crucial change. */
  const STEP_LADDER = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];

  function niceStep(rough) {
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    for (let i = 0; i < STEP_LADDER.length; i++) {
      if (norm <= STEP_LADDER[i] + 1e-9) return STEP_LADDER[i] * mag;
    }
    return 10 * mag;
  }

  /* Return {ticks, top} where top ≥ maxVal * 1.08, so the tallest bar
     can never be clipped and its value label has room above it. */
  function yAxisTicks(maxVal, targetTicks) {
    if (!(maxVal > 0)) return { ticks: [0, 1], top: 1 };
    const niceMax = maxVal * 1.08;
    const rough = niceMax / Math.max(1, targetTicks);
    const step = niceStep(rough);
    const top = Math.ceil(niceMax / step - 1e-9) * step;

    const ticks = [];
    for (let i = 0; i * step <= top + step * 1e-9; i++) ticks.push(i * step);

    /* Strip tiny FP residue from fractional steps. */
    if (step < 1) {
      for (let i = 0; i < ticks.length; i++) {
        ticks[i] = Math.round(ticks[i] * 1e6) / 1e6;
      }
    }
    return { ticks, top };
  }

  /* ---------------------------------------------------------------- */
  /* Histogram helpers                                                 */
  /* ---------------------------------------------------------------- */

  function parseNumericLabel(s) {
    if (s == null) return NaN;
    const str = String(s)
      .replace(/[,$\s%]/g, "")
      .replace(/[a-zA-Z]+$/, "")
      .trim();
    const n = parseFloat(str);
    return isFinite(n) ? n : NaN;
  }

  function extractAffix(label) {
    if (label == null) return { prefix: "", suffix: "" };
    const s = String(label);
    const m = s.match(/^([^0-9\-+.]*)(-?[\d,\.]+)([^0-9]*)$/);
    if (!m) return { prefix: "", suffix: "" };
    return { prefix: m[1] || "", suffix: m[3] || "" };
  }

  function buildHistogramBins(labels, values) {
    const counts = (values || []).map((v) => Number(v) || 0);
    const rawLabels = labels || [];
    const nums = rawLabels.map(parseNumericLabel);
    if (nums.length < 2 || !nums.every((n) => isFinite(n))) return null;

    const bins = [];
    if (nums.length > counts.length) {
      for (let i = 0; i < counts.length; i++) {
        const x1 = nums[i],
          x2 = nums[i + 1];
        if (!(x2 > x1)) continue;
        bins.push({
          x1,
          x2,
          count: counts[i],
          range: rawLabels[i] + " – " + rawLabels[i + 1],
        });
      }
    } else {
      for (let i = 0; i < counts.length; i++) {
        const c = nums[i];
        const pv = i > 0 ? nums[i - 1] : c - (nums[1] - c || 1);
        const nx =
          i < nums.length - 1 ? nums[i + 1] : c + (c - nums[i - 1] || 1);
        const x1 = (pv + c) / 2,
          x2 = (c + nx) / 2;
        if (!(x2 > x1)) continue;
        bins.push({ x1, x2, count: counts[i], range: rawLabels[i] });
      }
    }
    return bins.length ? bins : null;
  }

  function isLogSpaced(bins) {
    const pos = bins.map((b) => b.x1).filter((v) => v > 0);
    if (pos.length < 3) return false;
    return pos[pos.length - 1] / pos[0] > 50;
  }

  function computeKDE(bins, useLog, opts) {
    const gridPoints = (opts && opts.gridPoints) || 200;
    const bandwidthFactor = (opts && opts.bandwidthFactor) || 1.06;

    let N = 0;
    const pts = [];
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      if (!(b.count > 0)) continue;
      const mid = useLog
        ? b.x1 > 0 && b.x2 > 0
          ? Math.sqrt(b.x1 * b.x2)
          : NaN
        : (b.x1 + b.x2) / 2;
      if (!isFinite(mid)) continue;
      const x = useLog ? Math.log(mid) : mid;
      if (!isFinite(x)) continue;
      pts.push({ x, c: b.count });
      N += b.count;
    }
    if (N < 3 || pts.length < 2) return null;

    let mean = 0;
    for (let i = 0; i < pts.length; i++) mean += pts[i].x * pts[i].c;
    mean /= N;

    let variance = 0;
    for (let i = 0; i < pts.length; i++) {
      const d = pts[i].x - mean;
      variance += pts[i].c * d * d;
    }
    variance /= N;
    const sigma = Math.sqrt(variance);
    if (!(sigma > 0)) return null;

    const h = bandwidthFactor * sigma * Math.pow(N, -0.2);
    if (!(h > 0)) return null;

    const xMin = useLog ? Math.log(bins[0].x1) : bins[0].x1;
    const xMax = useLog
      ? Math.log(bins[bins.length - 1].x2)
      : bins[bins.length - 1].x2;

    const inv2h2 = 1 / (2 * h * h);
    const norm = 1 / (N * h * Math.sqrt(2 * Math.PI));

    const out = [];
    let peak = 0;
    for (let i = 0; i <= gridPoints; i++) {
      const xg = xMin + (xMax - xMin) * (i / gridPoints);
      let sum = 0;
      for (let j = 0; j < pts.length; j++) {
        const d = xg - pts[j].x;
        sum += pts[j].c * Math.exp(-d * d * inv2h2);
      }
      const density = norm * sum;
      out.push({ x: useLog ? Math.exp(xg) : xg, density });
      if (density > peak) peak = density;
    }
    return { points: out, peak, bandwidth: h, n: N };
  }

  /* ---------------------------------------------------------------- */
  /* Shared plotting helpers                                           */
  /* ---------------------------------------------------------------- */

  const rowsOf = (series) => {
    if (!series || !Array.isArray(series.labels)) return [];
    return series.labels.map((label, i) => ({
      label: String(label),
      value: Number((series.values || [])[i] ?? 0),
    }));
  };

  const yTickFmt = (v) =>
    Math.abs(v) >= 1000 ? fmtShort(v) : String(Math.round(v));

  /* ---------------------------------------------------------------- */
  /* Distribution: histogram + KDE                                     */
  /* ---------------------------------------------------------------- */

  function drawDistribution(el, w, h, series, opts) {
    opts = opts || {};
    const fill = opts.fill || ROSE;
    const xLabel = opts.xLabel || "";

    if (!series || !series.labels || !series.labels.length) {
      el.innerHTML =
        '<span style="font-size:.7rem;color:#adb5bd;font-style:italic;">No data</span>';
      return;
    }

    const bins = buildHistogramBins(series.labels, series.values);
    if (!bins) {
      drawVBar(el, w, h, series, { fill, xLabel });
      return;
    }

    const maxCount =
      Math.max.apply(
        null,
        bins.map((b) => b.count),
      ) || 1;
    const yMax = maxCount * 1.08;
    const useLog = isLogSpaced(bins);

    const xMinRaw = bins[0].x1;
    const xMaxRaw = bins[bins.length - 1].x2;
    const xDomain = useLog
      ? [Math.max(xMinRaw, 1e-6), xMaxRaw]
      : [xMinRaw, xMaxRaw];

    const affix = extractAffix(series.labels[0]);
    function fmtX(v) {
      const a = Math.abs(v);
      let num;
      if (a >= 1e6) num = (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      else if (a >= 1e3) num = (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
      else if (a >= 100) num = String(Math.round(v));
      else if (a >= 1) num = Number.isInteger(v) ? String(v) : v.toFixed(1);
      else if (v === 0) num = "0";
      else num = v.toFixed(2);
      return affix.prefix + num + affix.suffix;
    }

    const marks = [
      Plot.ruleY([0], { stroke: RULE_COLOR }),
      Plot.rectY(bins, {
        x1: "x1",
        x2: "x2",
        y1: 0,
        y2: "count",
        fill,
        fillOpacity: 0.82,
        title: (d) => d.range + "\n" + fmtInt(d.count) + " listings",
      }),
    ];

    if (series.median != null && isFinite(series.median)) {
      marks.push(
        Plot.ruleX([series.median], {
          stroke: MEDIAN_COLOR,
          strokeWidth: 1,
          strokeDasharray: "3,2",
        }),
      );
    }

    const kde = computeKDE(bins, useLog, opts.kde || {});
    if (kde && kde.peak > 0) {
      const scale = maxCount / kde.peak;
      const kdeSeries = kde.points.map((p) => ({
        x: p.x,
        y: p.density * scale,
      }));
      marks.push(
        Plot.line(kdeSeries, {
          x: "x",
          y: "y",
          stroke: KDE_STROKE,
          strokeWidth: 1.6,
          strokeLinejoin: "round",
          strokeLinecap: "round",
        }),
      );
    }

    el.appendChild(
      Plot.plot({
        width: w,
        height: h,
        marginTop: 10,
        marginRight: 12,
        marginBottom: 36,
        marginLeft: 46,
        style: {
          fontSize: "10px",
          fontFamily: FONT,
          background: "transparent",
        },
        x: {
          label: xLabel,
          labelAnchor: "center",
          labelArrow: false,
          type: useLog ? "log" : "linear",
          domain: xDomain,
          ticks: useLog ? 4 : 5,
          tickFormat: fmtX,
          tickSize: 0,
          tickPadding: 3,
          grid: false,
        },
        y: {
          label: "Listings",
          labelAnchor: "center",
          labelArrow: false,
          domain: [0, yMax],
          ticks: 3,
          nice: false, // domain already padded — don't let Plot re-round it
          tickSize: 0,
          tickPadding: 3,
          grid: true,
          gridStroke: GRID_COLOR,
          tickFormat: yTickFmt,
        },
        marks,
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Vertical bar chart (categorical)                                  */
  /* ---------------------------------------------------------------- */

  function drawVBar(el, w, h, series, opts) {
    opts = opts || {};
    const fill = opts.fill || ROSE;
    const xLabel = opts.xLabel || "";
    const yLabel = opts.yLabel || "Listings";
    const forceRotate = opts.rotate;

    const rows = rowsOf(series);
    if (!rows.length) {
      el.innerHTML =
        '<span style="font-size:.7rem;color:#adb5bd;font-style:italic;">No data</span>';
      return;
    }

    const maxVal =
      Math.max.apply(
        null,
        rows.map((r) => r.value),
      ) || 1;

    /* Guarantee headroom ≥ 8% so the tallest bar + its label fit. */
    const scale = yAxisTicks(maxVal, 3);
    const ticks = scale.ticks;
    const yTop = scale.top;
    const tickSet = new Set(ticks);

    const plotWidth = Math.max(20, w - 46 - 8);
    const perBar = plotWidth / rows.length;
    const longLabel = rows.some((r) => r.label.length > 6);
    const rotate =
      forceRotate != null
        ? forceRotate
        : rows.length > 6 || longLabel
          ? -30
          : 0;

    const showValues = perBar >= 22;

    const marks = [
      Plot.barY(rows, {
        x: "label",
        y: "value",
        fill,
        fillOpacity: 0.85,
        title: (d) => d.label + "\n" + fmtInt(d.value) + " listings",
      }),
      Plot.ruleY([0], { stroke: RULE_COLOR }),
    ];

    if (showValues) {
      marks.push(
        Plot.text(rows, {
          x: "label",
          y: "value",
          text: (d) => (d.value > 0 ? fmtShort(d.value) : ""),
          dy: -4,
          fontSize: 9,
          fontWeight: 600,
          fill: VALUE_COLOR,
          pointerEvents: "none",
        }),
      );
    }

    el.appendChild(
      Plot.plot({
        width: w,
        height: h,
        marginTop: 16,
        marginRight: 8,
        marginBottom: rotate ? 44 : 34,
        marginLeft: 46,
        style: {
          fontSize: "10px",
          fontFamily: FONT,
          background: "transparent",
        },
        x: {
          label: xLabel,
          labelAnchor: "center",
          labelArrow: false,
          tickRotate: rotate,
          tickAnchor: rotate ? "end" : "middle",
          tickSize: 0,
          tickPadding: 3,
          domain: rows.map((r) => r.label),
        },
        y: {
          label: yLabel,
          labelAnchor: "center",
          labelArrow: false,
          domain: [0, yTop],
          ticks,
          tickFormat: (v) => (tickSet.has(v) ? yTickFmt(v) : ""),
          nice: false,
          tickSize: 0,
          tickPadding: 3,
          grid: true,
          gridStroke: GRID_COLOR,
        },
        marks,
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Horizontal bar chart (categorical)                                */
  /* ---------------------------------------------------------------- */

  function drawHBar(el, w, h, series, opts) {
    opts = opts || {};
    const fill = opts.fill || ROSE_SOFT;
    const xLabel = opts.xLabel || "Listings";

    const rows = rowsOf(series);
    if (!rows.length) {
      el.innerHTML =
        '<span style="font-size:.7rem;color:#adb5bd;font-style:italic;">No data</span>';
      return;
    }

    const longest = Math.max.apply(
      null,
      rows.map((r) => r.label.length),
    );
    const labelW = Math.min(Math.max(longest * 5.6, 56), w * 0.4);
    const maxVal =
      Math.max.apply(
        null,
        rows.map((r) => r.value),
      ) || 1;

    /* Same headroom guarantee on the x-axis. */
    const scale = yAxisTicks(maxVal, 3);
    const ticks = scale.ticks;
    const xTop = scale.top;
    const tickSet = new Set(ticks);

    el.appendChild(
      Plot.plot({
        width: w,
        height: h,
        marginTop: 8,
        marginRight: 52,
        marginBottom: 32,
        marginLeft: labelW,
        style: {
          fontSize: "10px",
          fontFamily: FONT,
          background: "transparent",
        },
        x: {
          label: xLabel,
          labelAnchor: "center",
          labelArrow: false,
          domain: [0, xTop],
          ticks,
          tickFormat: (v) => (tickSet.has(v) ? yTickFmt(v) : ""),
          nice: false,
          grid: true,
          gridStroke: GRID_COLOR,
          tickSize: 0,
          tickPadding: 3,
        },
        y: {
          label: null,
          domain: rows.map((r) => r.label),
          tickSize: 0,
          tickPadding: 3,
        },
        marks: [
          Plot.barX(rows, {
            y: "label",
            x: "value",
            fill,
            fillOpacity: 0.88,
            title: (d) => d.label + "\n" + fmtInt(d.value) + " listings",
          }),
          Plot.text(rows, {
            y: "label",
            x: "value",
            dx: 5,
            textAnchor: "start",
            text: (d) => fmtShort(d.value),
            fill: VALUE_COLOR,
            fontSize: 9.5,
            fontWeight: 600,
            pointerEvents: "none",
          }),
          Plot.ruleX([0], { stroke: RULE_COLOR }),
        ],
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Mount with resize + error handling                                */
  /* ---------------------------------------------------------------- */

  function mountSafe(id, draw) {
    const el = document.getElementById(id);
    if (!el) {
      console.warn("charts.js: missing #" + id);
      return;
    }

    let raf = null;
    function run() {
      const w = el.clientWidth,
        h = el.clientHeight;
      if (w < 30 || h < 30) return;
      el.replaceChildren();
      try {
        draw(el, w, h);
      } catch (err) {
        console.error("charts.js: render failed for #" + id, err);
        el.innerHTML =
          '<div style="padding:.4rem;color:#b00020;font-size:.7rem;">chart error</div>';
      }
    }
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(run);
    });
    ro.observe(el);
    window.addEventListener("resize", run);
    run();
  }

  /* ---------------------------------------------------------------- */
  /* Distribution toggle                                               */
  /* ---------------------------------------------------------------- */

  const state = { dist: "price" };

  const distMount = document.getElementById("chart-distribution");
  const distTitle = document.getElementById("dist-title");

  function renderDist() {
    if (!distMount) return;
    const series = (data.distributions || {})[state.dist];
    if (!series) return;
    if (distTitle) distTitle.textContent = series.title || "Distribution";

    const w = distMount.clientWidth,
      h = distMount.clientHeight;
    if (w < 30 || h < 30) return;

    distMount.replaceChildren();
    try {
      drawDistribution(distMount, w, h, series, {
        xLabel: DIST_XLABEL[state.dist] || "",
      });
    } catch (err) {
      console.error("charts.js: dist failed", err);
      distMount.innerHTML =
        '<div style="padding:.4rem;color:#b00020;font-size:.7rem;">chart error</div>';
    }
  }

  document.querySelectorAll('[data-toggle-group="dist"]').forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".toggle-btn");
      if (!btn) return;
      group
        .querySelectorAll(".toggle-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      state.dist = btn.dataset.value;
      renderDist();
    });
  });

  if (distMount) {
    let raf = null;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(renderDist);
    });
    ro.observe(distMount);
    window.addEventListener("resize", renderDist);
    renderDist();
  }

  /* ---------------------------------------------------------------- */
  /* Categorical charts                                                */
  /* ---------------------------------------------------------------- */

  mountSafe("chart-room-type", (el, w, h) =>
    drawVBar(el, w, h, data.room_type, {
      fill: ROSE,
      xLabel: "Room type",
      yLabel: "Listings",
    }),
  );

  mountSafe("chart-max-occupants", (el, w, h) =>
    drawVBar(el, w, h, data.max_occupants, {
      fill: ROSE,
      xLabel: "Guests",
      yLabel: "Listings",
    }),
  );

  mountSafe("chart-property-type", (el, w, h) =>
    drawHBar(el, w, h, data.property_type, {
      fill: ROSE_SOFT,
      xLabel: "Listings",
    }),
  );
})();
