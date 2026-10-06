/* Hosts accordion — with KDE overlay on the histograms.
 *
 * Renders:
 *   • Top-50 host leaderboard (scrollable) into #hostSnapshotList
 *   • Host-metric histogram + KDE  into #chart-host-acceptance
 *   • Host-blocked-days histogram + KDE into #chart-host-blocked
 *
 * Reads: <script id="city-hosts-data" type="application/json">{...}</script>
 * Requires Observable Plot on window.Plot.
 *
 * Histograms
 * ----------
 * The backend returns bin *edges* (from numpy.histogram): n+1 labels for
 * n counts. The renderer:
 *
 *   • draws contiguous bars via Plot.rectY({x1, x2, y1: 0, y2: "count"})
 *   • uses a continuous numeric x-axis (linear, or log when bins are
 *     exponentially spaced — e.g. portfolio size spanning 1 → 1,000+)
 *   • overlays a Gaussian KDE curve computed from the binned data
 *   • draws a dashed median rule
 *   • shows bin-range tooltips on hover
 *
 * KDE
 * ---
 * Because we only have binned data, the KDE treats each bin's midpoint as
 * `count` coincident observations. Weighted mean and σ are computed from
 * those points; Silverman's rule sets the bandwidth:
 *
 *     h = factor · σ · N^(−1/5)
 *
 * The kernel is evaluated on a 200-point grid across the plot domain and
 * scaled so its peak equals the histogram peak, so the two share a
 * common y-axis and the reader can see how well the smooth curve tracks
 * the bars. The curve is drawn in a darker rose so it reads on top of
 * the bars without obscuring them.
 */
(function () {
  "use strict";

  const dataEl = document.getElementById("city-hosts-data");
  if (!dataEl) return;

  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("hosts.js: invalid data", err);
    return;
  }
  if (!data) return;

  console.debug("[hosts.js] keys:", Object.keys(data));

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */
  const ROSE = "#ff385c";
  const ROSE_SOFT = "#ff8ba0";
  const KDE_STROKE = "#b3003c"; // darker rose — reads on top of bars
  const KDE_OPTIONS = { show: true, bandwidthFactor: 1.06, gridPoints: 200 };

  const PLOT_STYLE = { fontSize: "10px", background: "transparent" };
  const RULE_COLOR = "#dddddd";
  const GRID_COLOR = "#f1f3f5";
  const MEDIAN_COLOR = "#212529";

  const MIN_W = 30;
  const MIN_H = 30;

  const $ = (id) => document.getElementById(id);
  const dims = (el) => ({ w: el.clientWidth, h: el.clientHeight });

  /* ------------------------------------------------------------------ */
  /* Formatters                                                          */
  /* ------------------------------------------------------------------ */
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  function fmtMoney(v) {
    if (v == null || !isFinite(v) || v <= 0) return "–";
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
    return `$${Math.round(v)}`;
  }
  function fmtInt(n) {
    if (n == null || !isFinite(n)) return "—";
    return new Intl.NumberFormat().format(Math.round(n));
  }
  function initials(name) {
    if (!name) return "?";
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }

  /* ------------------------------------------------------------------ */
  /* Donut (superhost share)                                             */
  /* ------------------------------------------------------------------ */
  function renderDonut(summary) {
    const total = summary.total_hosts || 0;
    const superhosts = summary.superhost_count || 0;
    const pct =
      total > 0 ? Math.max(0, Math.min(100, (superhosts / total) * 100)) : 0;

    const C = 2 * Math.PI * 15;
    const fill = (pct / 100) * C;

    return `
      <svg class="host-donut" width="26" height="26" viewBox="0 0 36 36"
           role="img"
           aria-label="${pct.toFixed(0)}% superhosts (${superhosts} of ${total})">
        <title>${superhosts} of ${total} hosts are superhosts (${pct.toFixed(0)}%)</title>
        <circle cx="18" cy="18" r="15" fill="none" stroke="#ffe4e8" stroke-width="5"/>
        <circle cx="18" cy="18" r="15" fill="none" stroke="#ff385c" stroke-width="5"
                stroke-linecap="round"
                stroke-dasharray="${fill} ${C}"
                transform="rotate(-90 18 18)"/>
        <text x="18" y="22" text-anchor="middle"
              font-size="11" font-weight="700" fill="#212529">${pct.toFixed(0)}</text>
      </svg>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* Leaderboard                                                         */
  /* ------------------------------------------------------------------ */
  function renderLeaderboard() {
    const placeholder = $("hostSnapshotPlaceholder");
    const list = $("hostSnapshotList");
    const donutWrap = $("hostDonutWrap");
    if (!placeholder || !list) return;

    const rows = (data && data.rows) || [];
    const summary = (data && data.summary) || {};

    if (!rows.length) {
      placeholder.innerHTML =
        '<i class="fas fa-inbox"></i><p>No host data available</p>';
      placeholder.style.display = "flex";
      list.style.display = "none";
      return;
    }

    placeholder.style.display = "none";
    list.style.display = "flex";
    list.replaceChildren();

    if (donutWrap) {
      donutWrap.style.display = "inline-flex";
      donutWrap.innerHTML = renderDonut(summary);
    }

    const scroll = document.createElement("div");
    scroll.className = "host-list-scroll";

    rows.forEach((h, i) => {
      const name = h.host_name || "Host";
      const ratingTxt = h.avg_rating != null ? h.avg_rating.toFixed(2) : "–";
      const priceTxt =
        h.avg_price != null ? `$${Math.round(h.avg_price)}` : "–";

      const card = document.createElement("div");
      card.className = "host-card";
      card.innerHTML = `
        <span class="host-rank">#${i + 1}</span>
        <div class="host-avatar">
          ${
            h.host_picture_url
              ? `<img src="${escapeHtml(h.host_picture_url)}" alt=""
                    loading="lazy" referrerpolicy="no-referrer"
                    onerror="this.remove()">`
              : ""
          }
          <span class="host-initials">${escapeHtml(initials(name))}</span>
        </div>
        <div class="host-info">
          <div class="host-name-row">
            <span class="host-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            ${
              h.is_superhost
                ? '<span class="host-badge-super" title="Superhost"><i class="fas fa-award"></i></span>'
                : ""
            }
          </div>
          <div class="host-meta">
            <span><i class="fas fa-home"></i> ${h.listing_count}</span>
            <span><i class="fas fa-star"></i> ${ratingTxt}</span>
            <span><i class="fas fa-tag"></i> ${priceTxt}</span>
          </div>
        </div>
        <div class="host-revenue">
          <span class="host-revenue-num">${fmtMoney(h.total_revenue)}</span>
          <span class="host-revenue-lbl">est.</span>
        </div>
      `;
      scroll.appendChild(card);
    });

    list.appendChild(scroll);
  }

  /* ================================================================== */
  /* Histogram helpers                                                   */
  /* ================================================================== */

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
        const x1 = nums[i];
        const x2 = nums[i + 1];
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
        const x1 = (pv + c) / 2;
        const x2 = (c + nx) / 2;
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

  /* --------------------------------------------------------------- KDE */

  /* Gaussian KDE from binned counts.
   *
   * Each bin is treated as `count` coincident points at its midpoint
   * (geometric mean for log-spaced bins). Weighted mean / σ → Silverman
   * bandwidth → evaluate the kernel on a grid across the domain.
   *
   * Returns { points: [{x, density}], peak } or null if not enough data.
   */
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

    /* Weighted mean. */
    let mean = 0;
    for (let i = 0; i < pts.length; i++) mean += pts[i].x * pts[i].c;
    mean /= N;

    /* Weighted variance. */
    let variance = 0;
    for (let i = 0; i < pts.length; i++) {
      const d = pts[i].x - mean;
      variance += pts[i].c * d * d;
    }
    variance /= N;
    const sigma = Math.sqrt(variance);
    if (!(sigma > 0)) return null;

    /* Silverman's rule of thumb. */
    const h = bandwidthFactor * sigma * Math.pow(N, -0.2);
    if (!(h > 0)) return null;

    /* Grid endpoints (in the working space). */
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
      const x = useLog ? Math.exp(xg) : xg;
      out.push({ x, density });
      if (density > peak) peak = density;
    }
    return { points: out, peak, bandwidth: h, n: N };
  }

  /* ---------------------------------------------------- categorical fallback */

  function drawCategoricalHistogram(mount, series, fill) {
    const rows = series.labels.map((label, i) => ({
      label: String(label),
      value: Number((series.values || [])[i] ?? 0),
    }));
    const { w, h } = dims(mount);
    const max = Math.max(...rows.map((r) => r.value)) || 1;

    mount.appendChild(
      Plot.plot({
        width: w,
        height: h,
        marginTop: 10,
        marginRight: 10,
        marginBottom: 34,
        marginLeft: 40,
        style: PLOT_STYLE,
        x: {
          label: null,
          tickRotate: -35,
          tickSize: 0,
          tickPadding: 3,
          domain: rows.map((r) => r.label),
        },
        y: {
          label: null,
          grid: true,
          ticks: 3,
          nice: true,
          tickSize: 0,
          domain: [0, max * 1.15],
        },
        marks: [
          Plot.barY(rows, { x: "label", y: "value", fill, fillOpacity: 0.78 }),
          Plot.ruleY([0], { stroke: RULE_COLOR }),
        ],
      }),
    );
  }

  /* --------------------------------------------------- histogram + KDE */

  function drawHistogram(mount, series, opts) {
    opts = opts || {};
    const fill = opts.fill || ROSE;
    const showKDE = opts.kde ? opts.kde.show !== false : KDE_OPTIONS.show;

    if (!mount) return;

    if (!series || !series.labels || !series.labels.length) {
      mount.replaceChildren();
      mount.innerHTML =
        '<span style="font-size:.7rem;color:#adb5bd;font-style:italic;">' +
        "No data" +
        "</span>";
      return;
    }

    const { w, h } = dims(mount);
    if (w < MIN_W || h < MIN_H) return;

    mount.replaceChildren();
    mount.style.cssText = "";

    /* ---- bins ------------------------------------------------------- */
    const bins = buildHistogramBins(series.labels, series.values);
    if (!bins) {
      drawCategoricalHistogram(mount, series, fill);
      return;
    }

    const maxCount =
      Math.max.apply(
        null,
        bins.map((b) => b.count),
      ) || 1;
    const yMax = maxCount * 1.1;
    const useLog = isLogSpaced(bins);

    /* ---- x domain --------------------------------------------------- */
    const xMinRaw = bins[0].x1;
    const xMaxRaw = bins[bins.length - 1].x2;
    const xDomain = useLog
      ? [Math.max(xMinRaw, 1e-6), xMaxRaw]
      : [xMinRaw, xMaxRaw];

    /* ---- tick formatting -------------------------------------------- */
    const affix = extractAffix(series.labels[0]);
    function fmtTick(v) {
      let num;
      if (Math.abs(v) >= 10000) num = Math.round(v).toLocaleString();
      else if (Math.abs(v) >= 100) num = String(Math.round(v));
      else if (Math.abs(v) >= 1)
        num = Number.isInteger(v) ? String(v) : v.toFixed(1);
      else if (v === 0) num = "0";
      else num = v.toFixed(2);
      return affix.prefix + num + affix.suffix;
    }

    /* ---- marks ------------------------------------------------------ */

    const marks = [
      /* Zero baseline behind everything. */
      Plot.ruleY([0], { stroke: RULE_COLOR }),

      /* Histogram bars. */
      Plot.rectY(bins, {
        x1: "x1",
        x2: "x2",
        y1: 0,
        y2: "count",
        fill: fill,
        fillOpacity: 0.82,
        title: (d) => d.range + "\n" + fmtInt(d.count) + " listings",
      }),
    ];

    /* Median rule — visible under the KDE but over the bars. */
    if (series.median != null && isFinite(series.median)) {
      marks.push(
        Plot.ruleX([series.median], {
          stroke: MEDIAN_COLOR,
          strokeWidth: 1,
          strokeDasharray: "3,2",
        }),
      );
    }

    /* KDE overlay. */
    if (showKDE) {
      const kdeOpts = opts.kde || KDE_OPTIONS;
      const kde = computeKDE(bins, useLog, kdeOpts);
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
            /* Optional soft fill under the curve, subtle. */
            fill: KDE_STROKE,
            fillOpacity: 0.06,
          }),
        );
      }
    }

    /* ---- plot ------------------------------------------------------- */
    mount.appendChild(
      Plot.plot({
        width: w,
        height: h,
        marginTop: 12,
        marginRight: 10,
        marginBottom: 30,
        marginLeft: 38,
        style: PLOT_STYLE,
        x: {
          label: null,
          type: useLog ? "log" : "linear",
          domain: xDomain,
          ticks: useLog ? undefined : 5,
          tickFormat: fmtTick,
          tickSize: 0,
          tickPadding: 3,
          grid: false,
        },
        y: {
          label: null,
          domain: [0, yMax],
          ticks: 3,
          nice: true,
          tickSize: 0,
          tickPadding: 3,
          grid: true,
          gridStroke: GRID_COLOR,
          tickFormat: (v) =>
            v >= 1000 ? v / 1000 + "k" : String(Math.round(v)),
        },
        marks: marks,
      }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Host metric                                                         */
  /* ------------------------------------------------------------------ */
  function renderAcceptance() {
    const mount = $("chart-host-acceptance");
    const note = $("acceptance-note");
    const title = $("acceptance-title");
    if (!mount) return;

    const acc = data.acceptance || {};

    if (title) title.textContent = acc.title || "Host metric";

    if (acc.status === "unavailable") {
      mount.replaceChildren();
      mount.innerHTML =
        '<div style="padding:1rem;text-align:center;font-size:.7rem;color:#9ca3af;font-style:italic;">' +
        (acc.subtitle || "No host data available for this city") +
        "</div>";
      if (note) note.textContent = acc.note || "unavailable";
      return;
    }

    if (note) note.textContent = acc.note || "";
    drawHistogram(mount, acc, { fill: ROSE, kde: { show: true } });
  }

  /* ------------------------------------------------------------------ */
  /* Blocked days                                                        */
  /* ------------------------------------------------------------------ */
  function renderBlocked() {
    const mount = $("chart-host-blocked");
    const note = $("blocked-note");
    if (!mount) return;

    const blocked = data.blocked || {};

    if (blocked.status === "pending") {
      mount.replaceChildren();
      mount.innerHTML =
        '<div style="padding:1rem;text-align:center;font-size:.7rem;color:#9ca3af;font-style:italic;">' +
        "Calendar not synced.<br>" +
        '<code style="display:inline-block;margin-top:.4rem;background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:.62rem;">' +
        "sync_datasets --kind calendar</code>" +
        "</div>";
      if (note) note.textContent = "unavailable";
      return;
    }

    if (note) {
      if (blocked.mean != null && blocked.sample) {
        note.textContent = `μ ${blocked.mean} d  ·  ${fmtInt(blocked.sample)} listings`;
      } else {
        note.textContent = "";
      }
    }
    drawHistogram(mount, blocked, { fill: ROSE_SOFT, kde: { show: true } });
  }

  /* ------------------------------------------------------------------ */
  /* Scheduling                                                          */
  /* ------------------------------------------------------------------ */
  function renderAll() {
    renderLeaderboard();
    renderAcceptance();
    renderBlocked();
  }

  let raf = null;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      renderAll();
    });
  }

  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(schedule);
    ["chart-host-acceptance", "chart-host-blocked", "hostSnapshotList"].forEach(
      (id) => {
        const el = $(id);
        if (el) ro.observe(el);
      },
    );
  }
  window.addEventListener("resize", schedule);

  schedule();
})();
