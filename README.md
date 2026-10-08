# Inside Airbnb — City Catalogue & Analytics

An exploratory data analysis project that scrapes, caches, and visualises [Inside Airbnb](http://insideairbnb.com/) listings data across 123 cities worldwide. Built as a hands-on study of the Django request/response cycle, pandas-based aggregation, and hand-rolled D3 / Observable Plot visualisations — drawing from Antonio Melé's *Django 5 by Example* and Scott Murray's *Interactive Data Visualization for the Web*.

---

## Highlights

- **City catalogue** — browse 123 cities, filter by continent and country, search by city or region.
- **Per-city dashboard** — static snapshot cards, an interactive neighbourhood choropleth, a host leaderboard, and a superlatives strip that re-drives the map and the neighbourhood list.
- **Accordion analytics** — Listings, Availability, Reviews, and Hosts sections each open in place to reveal their own charts, cards, and toggles.
- **Charts from first principles** — histograms with KDE overlays, box plots, horizontal bars, heatmaps, and a donut — all drawn from pre-aggregated JSON via Observable Plot and D3.
- **Cached, precomputed, fast** — every aggregate is cached against the source file's mtime; a management command warms the whole cache ahead of the first request.
- **Data operations split out** — scraping, fixture generation, and dataset loading live in a `data_ops/` folder next to the Django app, so data pipelines never leak into the request/response side.

---

## Screenshots

### Start page — all cities
![Start page](https://github.com/user-attachments/assets/a009798f-1413-4879-8618-2389fc28aeda)

### Collapsible sidebar
![Sidebar open](https://github.com/user-attachments/assets/b5106655-05c4-483d-ac6b-1a2eac0a6456)

### Filter by continent and country
![Continent filter](https://github.com/user-attachments/assets/6028ebce-b980-4af9-a0f6-0363b339b0fb)
![Country filter](https://github.com/user-attachments/assets/f45f83aa-0022-4cb3-ac83-6487a9098a33)

### Persistent search in the topbar
Search by city name or region across all 123 cities — available on every page.
![Search focused](https://github.com/user-attachments/assets/f37025fa-da45-4a54-a68e-a05540d2dd58)
![Search results](https://github.com/user-attachments/assets/85b451af-9426-4377-ae5f-ffc0d0bb6486)

### City dashboard
Snapshot cards, interactive neighbourhood map, superlatives-driven leaderboard, plus three permanent charts — booking lead time, amenities, host portfolio split.
![Dashboard — overview](https://github.com/user-attachments/assets/621b9a26-81f5-47e1-ba89-07dafb265156)

Accordion panels open in place to reveal the Listings, Availability, Reviews, and Hosts analytics.
![Dashboard — accordion open](https://github.com/user-attachments/assets/a831b828-9e6a-4b2e-8e03-d8ea0c7b704d)
![Dashboard — more analytics](https://github.com/user-attachments/assets/9b25c5dd-1470-4292-af79-1860bb8edef1)
![Dashboard — host views](https://github.com/user-attachments/assets/3603436c-2085-4c96-9ed7-b3bf69118c7f)

---

## Tech stack

| Layer | What |
| --- | --- |
| Web framework | Django 5 |
| Data wrangling | (geo)pandas, NumPy |
| Scraping | requests + BeautifulSoup |
| Static charts | Observable Plot |
| Interactive map | D3 (choropleth) |
| Cache | Django cache framework (file/memory backend) |
| Icons | Font Awesome, Boxicons |

---

## Data flow

```
Inside Airbnb URLs ──► sync_datasets ──► dataset_cache/<city>/*.csv.gz
                                              │
                                              ▼
                                       compute_city_*  ──► cache
                                              │
                                              ▼
                                    ListView context ──► JSON <script>
                                              │
                                              ▼
                                        Frontend charts
```

Each dataset (`listings.csv.gz`, `reviews.csv.gz`, `calendar.csv.gz`, `neighbourhoods.geojson`) is downloaded once by the `sync_datasets` management command and stored on disk with a sidecar `.url` file recording the source URL. When the URL changes, the next sync re-downloads automatically.

Per-city aggregates — headline stats, distributions, review boxes, host metrics, availability KPIs, superlatives, and amenities — are computed from the cached CSV, cached themselves against the file's mtime, and invalidated on the next sync.

---

## Getting started

### 1. Clone and install

```bash
git clone <this-repo>
cd inside-airbnb
python -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure

Create a `.env` or export the following:

```bash
export DATASET_CACHE_DIR=./dataset_cache
export DJANGO_SECRET_KEY=<a-long-random-string>
export DEBUG=1
```

### 3. Migrate

```bash
python manage.py migrate
```

### 4. Generate the fixtures

The catalogue has no rows out of the box. Two standalone scripts under `listings/data_ops/` build the fixture files the project ships with:

| Script | Produces |
| --- | --- |
| `listings/data_ops/currency_data.py` | `fixtures/currencies.json` — one row per world currency (code, symbol, USD rate). |
| `listings/data_ops/city_data.py` | `fixtures/insideairbnb_cities.json` — one row per Inside Airbnb city, plus its Continent and Country parents. |

Run them as **plain Python files**, not `manage.py` commands:

```bash
python listings/data_ops/currency_data.py
python listings/data_ops/city_data.py
```

Each script has a `__main__` entry point, downloads or scrapes the source it needs, and writes its fixture into `listings/fixtures/`. They are self-contained and do not require Django to be bootstrapped.

> A third module in the same folder, `listings/data_ops/dataset.py`, is used by the `sync_datasets` management command to fetch and read the per-city CSVs. It is not run directly.

### 5. Seed the database

With both fixtures generated, load them in order:

```bash
python manage.py load_data
```

`load_data` is a custom management command that reads `currencies.json` and `insideairbnb_cities.json`, creates the `Continent`, `Country`, `Currency`, and `City` rows, and then **fills the model-form fields** — currency code, symbol, and USD rate on each Country, and the listing / review / calendar / neighbourhood URLs on each City — so the frontend has everything it needs to route requests and compute prices.

If you prefer to run the fixtures manually:

```bash
python manage.py loaddata currencies
python manage.py loaddata insideairbnb_cities
```

> **Why a custom command?** `loaddata` will happily insert the raw fixture rows, but it cannot derive the fields the fixture does not encode — currency-per-country wiring, URL composition from the city slug, display ordering. The `load_data` command reads the fixtures and then applies those derivations in one pass. Running only `loaddata` leaves the site technically functional but with no cities, countries, or currencies to show.

### 6. Download datasets

With cities and currencies in place, the per-city datasets can be fetched:

```bash
# All cities
python manage.py sync_datasets

# One city only
python manage.py sync_datasets --city paris

# One kind only
python manage.py sync_datasets --city paris --kind listings
```

Available kinds: `listings`, `reviews`, `calendar`, `neighbourhoods`.

### 7. Warm the cache (recommended)

Precomputing every aggregate makes the first page load effectively instant:

```bash
python manage.py precompute_cities
```

### 8. Run

```bash
python manage.py runserver
```

Open <http://127.0.0.1:8000/>.

---

## Project structure

```
inside-airbnb/
├── listings/
│   ├── data_ops/                  # all data work, kept out of the Django app suite
│   │   ├── currency_data.py       # __main__: scrapes currency codes → fixtures/currencies.json
│   │   ├── city_data.py           # __main__: scrapes city list  → fixtures/insideairbnb_cities.json
│   │   ├── dataset.py             # used by sync_datasets to fetch/read the CSVs
│   │   └── geojson_utils.py       # used by sync_datasets for the neighbourhood map
│   ├── datasets.py                # readers, aggregators, per-city compute functions
│   ├── models.py                  # Continent → Country → City, Currency
│   ├── views.py                   # CityListView (three states)
│   ├── fixtures/
│   │   ├── currencies.json        # produced by currency_data.py
│   │   └── insideairbnb_cities.json  # produced by city_data.py
│   └── management/commands/
│       ├── load_data.py           # seeds fixtures + fills derived model fields
│       ├── sync_datasets.py       # downloads listings / reviews / calendar / geojson
│       └── precompute_cities.py   # warms every per-city aggregate cache
├── static/
│   ├── css/city_list/style.css
│   └── js/city_list/
│       ├── charts.js              # Listings accordion — histograms + KDE
│       ├── availability.js        # Availability accordion
│       ├── reviews.js             # Reviews accordion
│       ├── hosts.js               # Hosts accordion + leaderboard
│       ├── boxes.js               # Shared box-plot renderer
│       ├── lead_time.js           # Booking lead-time histogram
│       ├── portfolio.js           # Portfolio split bar chart
│       ├── superlatives.js        # Superlatives cards
│       ├── neighbourhoods.js      # Neighbourhood leaderboard
│       ├── amenities.js           # Amenities list
│       ├── map.js                 # D3 choropleth
│       └── snapshot_boxes.js      # Mini box plots in snapshot cards
├── templates/listings/clts.html   # Single template with three states
└── dataset_cache/                 # Downloaded datasets (gitignored)
```

---

## Design principles

A few deliberate choices shape the project:

- **Data operations live next to the app, not inside it.** Scraping, fixture generation, and dataset loading sit in `listings/data_ops/`. The scripts are ordinary Python programs with `__main__` entry points — they can be run on a bare terminal without Django configured, which keeps the pipeline testable and the app suite clean.
- **Plain SVG via Observable Plot.** No wrapper libraries — quantile-based charts (box plots) and binned histograms are drawn from pre-computed JSON, so the server does the aggregation and the client does the rendering.
- **Server-side aggregation, cached.** Every chart's data is computed once, cached, and delivered as a `<script type="application/json">` block. The frontend parses and renders; it never touches raw CSV.
- **Self-explanatory charts.** Every axis carries a title, every histogram carries a median rule and (where useful) a KDE overlay, and every bar carries a tooltip with the exact value.
- **Compact-first layout.** Cells render at whatever size they get; when they get small, margins shrink, ticks thin, and non-essential elements disappear rather than overlap.
- **One template, three states.** The `CityListView` serves the same template for "all cities", "country selected", and "city selected" by branching on GET params.

---

## Credits

- Dataset: [Inside Airbnb](http://insideairbnb.com/) — Murray Cox and contributors.
- Structure and Django patterns: Antonio Melé, *Django 5 by Example*.
- D3 idioms: Scott Murray, *Interactive Data Visualization for the Web*.
- Plot grammar: [Observable Plot](https://observablehq.com/plot/).

---

## Licence

Code: MIT.
Data: see Inside Airbnb's own terms before redistribution.
