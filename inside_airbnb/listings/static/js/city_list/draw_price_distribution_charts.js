/* ─────────────────────────────────────────────────────────────
   listings_app/static/listings_app/js/charts/price_dist.js
   Price Distribution — histogram + KDE overlay.
   Reads from /listings/api/city/<slug>/analytics/
   ───────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const SLUG = document.body.dataset.citySlug;
  const IS_LOADED = document.body.dataset.cityLoaded === "true";
  const ANALYTICS_URL = `/listings/api/city/${SLUG}/analytics/`;

  const container = document.getElementById("priceChartContainer");
  const placeholder = document.getElementById("priceChartPlaceholder");
  const summaryEl = document.getElementById("priceSummary");
  if (!container) return;

  let payload = null;

  async function load() {
    if (payload !== null) return payload;
    if (!IS_LOADED) return null;
    try {
      const r = await fetch(ANALYTICS_URL, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      payload = json.price_distribution || null;
    } catch (err) {
      console.warn("Price distribution fetch failed:", err);
      payload = null;
    }
    return payload;
  }

  function showPlaceholder(icon, title, sub) {
    placeholder.style.display = "flex";
    placeholder.innerHTML = `
      <i class="${icon} fa-3x"></i>
      <p>${title}</p>
      ${sub ? `<small>${sub}</small>` : ""}
    `;
    const old = container.querySelector("svg");
    if (old) old.remove();
  }

  function renderSummary(summary) {
    if (!summary || !summary.median) {
      summaryEl.innerHTML = "";
      return;
    }
    summaryEl.innerHTML = `
      <span class="chip">median<b>$${Math.round(summary.median)}</b></span>
      <span class="chip">mean<b>$${Math.round(summary.mean)}</b></span>
      <span class="chip">n<b>${summary.count.toLocaleString()}</b></span>
    `;
  }

  function draw(data) {
    const hist = data.histogram || {};
    const kde = data.kde || {};
    const sum = data.summary || {};

    if (!hist.centers || !hist.counts || hist.counts.length === 0) {
      showPlaceholder(
        "fas fa-inbox",
        "No price data yet",
        "Reload city data to populate analytics",
      );
      return;
    }

    placeholder.style.display = "none";
    const old = container.querySelector("svg");
    if (old) old.remove();

    renderSummary(sum);

    const width = container.clientWidth || 500;
    const height = container.clientHeight || 320;
    const margin = { top: 16, right: 24, bottom: 40, left: 48 };
    const innerW = Math.max(80, width - margin.left - margin.right);
    const innerH = Math.max(80, height - margin.top - margin.bottom);

    const xMax = hist.bin_edges[hist.bin_edges.length - 1];
    const xMin = hist.bin_edges[0];

    const x = d3.scaleLinear().domain([xMin, xMax]).range([0, innerW]);
    const yHist = d3
      .scaleLinear()
      .domain([0, d3.max(hist.counts) * 1.1])
      .nice()
      .range([innerH, 0]);
    const yKde = d3
      .scaleLinear()
      .domain([0, d3.max(kde.y) * 1.15 || 1])
      .range([innerH, 0]);

    const svg = d3
      .select(container)
      .append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .style("width", "100%")
      .style("height", "100%");

    const g = svg
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    g.append("g")
      .attr("class", "grid")
      .call(d3.axisLeft(yHist).ticks(4).tickSize(-innerW).tickFormat(""))
      .selectAll("line")
      .attr("stroke", "#e9ecef");
    g.select(".grid .domain").remove();

    const barW = innerW / hist.counts.length;
    g.selectAll(".bar")
      .data(hist.counts)
      .enter()
      .append("rect")
      .attr("class", "bar")
      .attr("x", (_, i) => x(hist.bin_edges[i]))
      .attr("y", (d) => yHist(d))
      .attr("width", Math.max(1, barW - 1))
      .attr("height", (d) => innerH - yHist(d))
      .attr("fill", "#ff8fa3")
      .attr("opacity", 0.75)
      .attr("rx", 2);

    const line = d3
      .line()
      .x((d) => x(d.x))
      .y((d) => yKde(d.y))
      .curve(d3.curveBasis);

    const kdePoints = kde.x.map((xv, i) => ({ x: xv, y: kde.y[i] }));

    g.append("path")
      .datum(kdePoints)
      .attr("fill", "none")
      .attr("stroke", "#c9184a")
      .attr("stroke-width", 2.5)
      .attr("d", line);

    const area = d3
      .area()
      .x((d) => x(d.x))
      .y0(innerH)
      .y1((d) => yKde(d.y))
      .curve(d3.curveBasis);

    g.append("path")
      .datum(kdePoints)
      .attr("fill", "#c9184a")
      .attr("opacity", 0.08)
      .attr("d", area);

    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(
        d3
          .axisBottom(x)
          .ticks(6)
          .tickFormat((d) => `$${Math.round(d)}`),
      )
      .selectAll("text")
      .attr("font-size", 11)
      .attr("fill", "#495057");

    g.append("g")
      .call(d3.axisLeft(yHist).ticks(4).tickFormat(d3.format(".2s")))
      .selectAll("text")
      .attr("font-size", 11)
      .attr("fill", "#495057");

    g.select(".domain").attr("stroke", "#dee2e6");

    if (sum.median) {
      g.append("line")
        .attr("x1", x(sum.median))
        .attr("x2", x(sum.median))
        .attr("y1", 0)
        .attr("y2", innerH)
        .attr("stroke", "#495057")
        .attr("stroke-dasharray", "4 4")
        .attr("stroke-width", 1);

      g.append("text")
        .attr("x", x(sum.median) + 4)
        .attr("y", 12)
        .attr("font-size", 10)
        .attr("fill", "#495057")
        .text(`median $${Math.round(sum.median)}`);
    }

    svg
      .append("text")
      .attr("x", margin.left + innerW / 2)
      .attr("y", height - 6)
      .attr("text-anchor", "middle")
      .attr("font-size", 11)
      .attr("fill", "#adb5bd")
      .text("Nightly price (USD)");
  }

  async function render() {
    if (!IS_LOADED) {
      showPlaceholder(
        "fas fa-cloud-download-alt",
        "Load data to see price distribution",
        'Click "Load Data" above',
      );
      return;
    }
    const data = await load();
    if (!data || !data.histogram) {
      showPlaceholder(
        "fas fa-inbox",
        "Price distribution not computed yet",
        "Run: python manage.py populate_cities --prices",
      );
      return;
    }
    draw(data);
  }

  let t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(render, 250);
  });

  document.addEventListener("city:data-loaded", () => {
    payload = null;
    render();
  });

  document.addEventListener("DOMContentLoaded", render);
})();
