/* Reviews accordion: cards, box plots, longest reviews, monthly line. */
(function () {
  "use strict";

  const dataEl = document.getElementById("city-reviews-data");
  if (!dataEl) return;

  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("reviews.js: invalid data", err);
    return;
  }

  const $ = (id) => document.getElementById(id);
  const dims = (el) => ({ w: el.clientWidth, h: el.clientHeight });

  function fmtInt(n) {
    if (n == null || !isFinite(n)) return "—";
    return new Intl.NumberFormat().format(Math.round(n));
  }

  /* ---- Cards -------------------------------------------------- */
  function renderCards() {
    const c = data.cards || {};
    $("rev-card-total")?.replaceChildren(
      document.createTextNode(fmtInt(c.total_reviews)),
    );
    $("rev-card-rating")?.replaceChildren(
      document.createTextNode(
        c.avg_rating != null ? c.avg_rating.toFixed(2) : "—",
      ),
    );
    $("rev-card-avglen")?.replaceChildren(
      document.createTextNode(fmtInt(c.avg_length)),
    );
    $("rev-card-medlen")?.replaceChildren(
      document.createTextNode(fmtInt(c.median_length)),
    );
  }

  /* ---- Review score box plots --------------------------------- */
  function renderBoxes() {
    const mount = $("chart-review-boxes");
    if (!mount || typeof window.drawBoxPlots !== "function") return;
    const boxes = data.review_boxes || [];
    if (!boxes.length) {
      mount.innerHTML =
        '<span style="font-size:.7rem;color:#adb5bd;font-style:italic;">No score data</span>';
      return;
    }
    window.drawBoxPlots(mount, boxes, { compact: false, digits: 2 });
  }

  /* ---- Monthly line chart ------------------------------------- */
  const state = { year: null };

  function pickDefaultYear() {
    const years = data.years || [];
    for (const y of years) {
      if ((data.year_counts[y] || 0) >= 50) return y;
    }
    return years[1] || null;
  }

  function populateYearSelect() {
    const sel = $("revYearMonthly");
    if (!sel) return;
    const years = data.years || [];
    sel.replaceChildren();
    years.forEach((y) => {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = `${y} (${fmtInt(data.year_counts[y])})`;
      sel.appendChild(opt);
    });
    if (state.year) sel.value = state.year;
  }

  function drawMonthly(series) {
    const mount = $("chart-rev-monthly");
    if (!mount) return;
    if (!series || !series.values || !series.values.length) {
      mount.innerHTML =
        '<span style="font-size:.7rem;color:#adb5bd;font-style:italic;">No data</span>';
      return;
    }
    const { w, h } = dims(mount);
    if (w < 30 || h < 30) return;

    mount.replaceChildren();
    const rows = series.labels.map((label, i) => ({
      label,
      value: series.values[i] ?? 0,
      idx: i,
    }));
    const max = Math.max(...rows.map((r) => r.value));
    const yMax = max > 0 ? max * 1.2 : 1;

    mount.appendChild(
      Plot.plot({
        width: w,
        height: h,
        marginTop: 20,
        marginRight: 12,
        marginBottom: 26,
        marginLeft: 42,
        style: { fontSize: "10px", background: "transparent" },
        x: {
          label: null,
          domain: rows.map((r) => r.idx),
          ticks: rows.map((_, i) => i),
          tickFormat: (d) => rows[d]?.label ?? "",
          tickSize: 0,
          tickPadding: 3,
        },
        y: {
          label: null,
          grid: true,
          ticks: 4,
          domain: [0, yMax],
          nice: false,
          tickSize: 0,
          tickFormat: (d) =>
            d >= 1000
              ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}K`
              : String(d),
        },
        marks: [
          Plot.areaY(rows, {
            x: "idx",
            y: "value",
            fill: "#ff385c",
            fillOpacity: 0.12,
            curve: "monotone-x",
          }),
          Plot.line(rows, {
            x: "idx",
            y: "value",
            stroke: "#ff385c",
            strokeWidth: 2.2,
            curve: "monotone-x",
          }),
          Plot.dot(rows, { x: "idx", y: "value", fill: "#ff385c", r: 2.6 }),
          Plot.ruleY([0], { stroke: "#dddddd" }),
        ],
      }),
    );
  }

  function drawCharts() {
    if (!state.year) return;
    drawMonthly(data.monthly_by_year?.[state.year]);
  }

  /* ---- Longest reviews list ----------------------------------- */
  function renderReviewList(year) {
    const list = $("revList");
    const note = $("revSentNote");
    if (!list) return;
    const reviews = (data.top_reviews_by_year || {})[year] || [];
    if (!reviews.length) {
      list.replaceChildren();
      const p = document.createElement("div");
      p.className = "rev-placeholder";
      p.textContent = "No reviews with text for this year";
      list.appendChild(p);
      if (note) note.textContent = "";
      return;
    }
    if (note) note.textContent = `${reviews.length} longest`;
    list.replaceChildren();
    reviews.forEach((r) => {
      const item = document.createElement("div");
      item.className = "rev-item";
      item.innerHTML = `
        <div class="rev-item-head">
          <span class="rev-date">${r.date}</span>
          <span class="rev-len">${fmtInt(r.length)} ch</span>
        </div>
        <div class="rev-text"></div>
      `;
      item.querySelector(".rev-text").textContent = r.text;
      list.appendChild(item);
    });
  }

  /* ---- Orchestration ------------------------------------------ */
  function redrawAll() {
    renderCards();
    renderBoxes();
    drawCharts();
    if (state.year) renderReviewList(state.year);
  }

  let raf = null;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      redrawAll();
    });
  }

  ["chart-review-boxes", "chart-rev-monthly"].forEach((id) => {
    const el = $(id);
    if (el && "ResizeObserver" in window) {
      new ResizeObserver(schedule).observe(el);
    }
  });
  window.addEventListener("resize", schedule);

  document.addEventListener("change", (e) => {
    if (!e.target.matches(".rev-year-select")) return;
    state.year = e.target.value;
    const sel = $("revYearMonthly");
    if (sel) sel.value = state.year;
    drawCharts();
    renderReviewList(state.year);
  });

  state.year = pickDefaultYear();
  populateYearSelect();
  schedule();
})();
