/* Amenities card for the bottom-row middle cell.
 *
 * Reads:
 *   <script id="city-amenities-data" type="application/json">{...}</script>
 * Renders:
 *   #amenitiesList   — top-N amenities, each a label + % + gradient bar
 *   #amenities-badge — the listing count backing the sample
 */
(function () {
  "use strict";

  const dataEl = document.getElementById("city-amenities-data");
  const list = document.getElementById("amenitiesList");
  const badge = document.getElementById("amenities-badge");
  if (!dataEl || !list) return;

  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("amenities.js: invalid data", err);
    return;
  }
  if (!data) return;

  console.debug("[amenities.js] items:", (data.items || []).length);

  const items = data.items || [];

  if (badge) {
    badge.textContent = data.total
      ? `${new Intl.NumberFormat().format(data.total)} listings`
      : "";
  }

  if (!items.length) {
    list.replaceChildren();
    const p = document.createElement("div");
    p.className = "amenities-placeholder";
    p.textContent = "No amenity data for this city.";
    list.appendChild(p);
    return;
  }

  list.replaceChildren();

  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "amenity";
    el.innerHTML = `
      <span class="amenity__label" title="${item.label}">${item.label}</span>
      <span class="amenity__pct">${item.pct.toFixed(0)}%</span>
      <span class="amenity__bar"><span style="width:${item.pct}%"></span></span>
    `;
    list.appendChild(el);
  });
})();
