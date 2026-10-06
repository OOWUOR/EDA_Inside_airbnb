/* Availability accordion.
 *
 * Renders:
 *   • four KPI cards (availability_30/60/90/365)         → #avail-card-30/60/90/365
 *   • weekday availability bars                          → #chart-avail-weekday
 *   • minimum-nights-by-month line                       → #chart-avail-min-nights
 *   • forward-availability heatmap (GitHub-style grid)   → #chart-avail-heatmap
 *
 * Reads: <script id="city-availability-data" type="application/json">{...}</script>
 * Requires Observable Plot + d3 on window.
 */
(function () {
  "use strict";

  const dataEl = document.getElementById("city-availability-data");
  if (!dataEl) return;

  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("availability.js: invalid data", err);
    return;
  }
  if (!data) return;

  console.debug("[availability.js] calendar_status:", data.calendar_status);

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */
  const ROSE = "#ff385c";
  const ROSE_SOFT = "#ff8ba0";
  const PLOT_STYLE = { fontSize: "10px", background: "transparent" };
  const RULE_COLOR = "#dddddd";
  const MIN_W = 30;
  const MIN_H = 30;

  const $ = (id) => document.getElementById(id);
  const dims = (el) => ({ w: el.clientWidth, h: el.clientHeight });

  function showHint(el, html) {
    if (!el) return;
    el.replaceChildren();
    el.innerHTML = `<div class="avail-hint">${html}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* KPI cards                                                           */
  /* ------------------------------------------------------------------ */
  function renderCards() {
    const c = data.cards || {};
    const set = (id, v) => {
      const el = $(id);
      if (!el) return;
      el.textContent = v != null ? `${v} d` : "—";
    };
    set("avail-card-30", c.availability_30);
    set("avail-card-60", c.availability_60);
    set("avail-card-90", c.availability_90);
    set("avail-card-365", c.availability_365);
  }

  /* ------------------------------------------------------------------ */
  /* Weekday bars                                                        */
  /* ------------------------------------------------------------------ */
  function renderWeekday() {
    const mount = $("chart-avail-weekday");
    const note = $("avail-weekday-note");
    if (!mount) return;

    const series = data.weekday || {};
    if (!series.labels || !series.labels.length) {
      showHint(
        mount,
        "Calendar not synced.<br><code>sync_datasets --kind calendar</code>",
      );
      if (note) note.textContent = "";
      return;
    }

    const { w, h } = dims(mount);
    if (w < MIN_W || h < MIN_H) return;
    mount.replaceChildren();
    mount.style.cssText = "";

    const rows = series.labels.map((label, i) => ({
      label,
      pct: (series.values[i] ?? 0) * 100,
    }));

    // find tightest & loosest day
    const sorted = [...rows].sort((a, b) => a.pct - b.pct);
    if (note) {
      note.textContent = `${sorted[0].label} tightest · ${sorted[6].label} loosest`;
    }

    mount.appendChild(
      Plot.plot({
        width: w,
        height: h,
        marginTop: 12,
        marginRight: 10,
        marginBottom: 24,
        marginLeft: 34,
        style: PLOT_STYLE,
        x: {
          label: null,
          tickSize: 0,
          tickPadding: 3,
          domain: rows.map((r) => r.label),
        },
        y: {
          label: null,
          grid: true,
          ticks: 3,
          nice: false,
          tickSize: 0,
          domain: [0, 100],
        },
        marks: [
          Plot.barY(rows, {
            x: "label",
            y: "pct",
            fill: ROSE,
            fillOpacity: 0.75,
          }),
          Plot.ruleY([0], { stroke: RULE_COLOR }),
        ],
      }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Min-nights line                                                     */
  /* ------------------------------------------------------------------ */
  function renderMinNights() {
    const mount = $("chart-avail-min-nights");
    if (!mount) return;

    const series = data.min_nights_by_month || {};
    if (!series.labels || !series.labels.length) {
      showHint(
        mount,
        "Calendar not synced.<br><code>sync_datasets --kind calendar</code>",
      );
      return;
    }

    const { w, h } = dims(mount);
    if (w < MIN_W || h < MIN_H) return;
    mount.replaceChildren();
    mount.style.cssText = "";

    const rows = series.labels.map((label, i) => ({
      label,
      value: series.values[i] ?? 0,
      idx: i,
    }));

    const max = Math.max(...rows.map((r) => r.value));
    const yMax = max > 0 ? Math.ceil(max * 1.2) : 1;

    mount.appendChild(
      Plot.plot({
        width: w,
        height: h,
        marginTop: 14,
        marginRight: 12,
        marginBottom: 30,
        marginLeft: 30,
        style: PLOT_STYLE,
        x: {
          label: null,
          domain: rows.map((r) => r.idx),
          ticks: rows.map((_, i) => i),
          tickFormat: (d) => rows[d]?.label ?? "",
          tickRotate: -40,
          tickSize: 0,
          tickPadding: 3,
        },
        y: {
          label: null,
          grid: true,
          ticks: 4,
          nice: false,
          tickSize: 0,
          domain: [0, yMax],
        },
        marks: [
          Plot.areaY(rows, {
            x: "idx",
            y: "value",
            fill: ROSE,
            fillOpacity: 0.12,
            curve: "monotone-x",
          }),
          Plot.line(rows, {
            x: "idx",
            y: "value",
            stroke: ROSE,
            strokeWidth: 2,
            curve: "monotone-x",
          }),
          Plot.dot(rows, { x: "idx", y: "value", fill: ROSE, r: 2.5 }),
          Plot.ruleY([0], { stroke: RULE_COLOR }),
        ],
      }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Heatmap                                                             */
  /* ------------------------------------------------------------------ */
  function colorFor(v) {
    if (v == null) return "#f3f4f6";
    if (v < 0.15) return "#e11d48"; // fully booked
    if (v < 0.3) return "#ff385c";
    if (v < 0.5) return "#ff8ba0";
    if (v < 0.7) return "#ffc2cc";
    if (v < 0.9) return "#ffe4e8";
    return "#fff5f7"; // wide open
  }

  function renderHeatmap() {
    const mount = $("chart-avail-heatmap");
    const note = $("avail-heat-note");
    if (!mount) return;

    const points = data.heatmap || [];
    if (!points.length) {
      showHint(
        mount,
        "Calendar not synced.<br><code>sync_datasets --kind calendar</code>",
      );
      if (note) note.textContent = "";
      return;
    }

    const { w, h } = dims(mount);
    if (w < 60 || h < 60) return;

    mount.replaceChildren();
    mount.style.cssText = "";

    // Date range
    const dates = points
      .map((p) => new Date(p.date + "T00:00:00Z"))
      .sort((a, b) => a - b);
    const first = dates[0];
    const last = dates[dates.length - 1];

    // Align start to Monday
    const start = new Date(first);
    const dow = (start.getUTCDay() + 6) % 7; // 0 = Mon
    start.setUTCDate(start.getUTCDate() - dow);

    // Number of weeks needed
    const totalDays = Math.round((last - start) / 86400000) + 1;
    const weeks = Math.ceil(totalDays / 7);

    // Value lookup
    const byDate = new Map();
    points.forEach((p) => byDate.set(p.date, p.available));

    // Layout
    const padTop = 6,
      padLeft = 16,
      padRight = 6,
      padBottom = 6;
    const innerW = w - padLeft - padRight;
    const innerH = h - padTop - padBottom;
    const cellW = innerW / weeks;
    const cellH = innerH / 7;
    const size = Math.max(3, Math.min(cellW - 1, cellH - 1));

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.width = "100%";
    svg.style.height = "100%";
    mount.appendChild(svg);

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `translate(${padLeft}, ${padTop})`);
    svg.appendChild(g);

    // Cells
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      if (d > last) break;
      const iso = d.toISOString().slice(0, 10);
      const v = byDate.get(iso);
      const row = i % 7;
      const col = Math.floor(i / 7);

      const rect = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect",
      );
      rect.setAttribute("x", col * (size + 1));
      rect.setAttribute("y", row * (size + 1));
      rect.setAttribute("width", size);
      rect.setAttribute("height", size);
      rect.setAttribute("rx", 1.5);
      rect.setAttribute("fill", colorFor(v));
      rect.setAttribute("stroke", "#ffffff");
      rect.setAttribute("stroke-width", 0.4);

      const title = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "title",
      );
      title.textContent =
        v == null
          ? `${iso}: no data`
          : `${iso}: ${(v * 100).toFixed(0)}% available`;
      rect.appendChild(title);

      g.appendChild(rect);
    }

    // Day-of-week labels (Mon / Wed / Fri)
    ["Mon", null, "Wed", null, "Fri", null, null].forEach((label, i) => {
      if (!label) return;
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", -4);
      t.setAttribute("y", i * (size + 1) + size - 1);
      t.setAttribute("text-anchor", "end");
      t.setAttribute("font-size", "7");
      t.setAttribute("fill", "#9ca3af");
      t.textContent = label;
      g.appendChild(t);
    });

    // Header note — date range covered
    if (note) {
      const fmt = (dt) =>
        dt.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
      note.textContent = `${fmt(first)} – ${fmt(last)}`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Orchestration                                                       */
  /* ------------------------------------------------------------------ */
  function renderAll() {
    renderCards();
    renderWeekday();
    renderMinNights();
    renderHeatmap();
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
    [
      "chart-avail-weekday",
      "chart-avail-min-nights",
      "chart-avail-heatmap",
    ].forEach((id) => {
      const el = $(id);
      if (el) ro.observe(el);
    });
  }
  window.addEventListener("resize", schedule);

  schedule();
})();
