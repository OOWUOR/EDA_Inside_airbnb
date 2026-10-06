"""This module builds a catalogue of the datasets published by Inside Airbnb.
It works as the main data collection gateways that autonomously collects
City, Continent , and Countries data to fill respective Models forms

"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pandas as pd
from bs4 import BeautifulSoup
from curl_cffi import requests

_SLUG_STRIP = re.compile(r"[^\w\s-]")
_SLUG_COLLAPSE = re.compile(r"[\s_-]+")


def _slugify(value: str) -> str:
    """Tiny slugify so this scraper doesn't require Django to be configured."""
    cleaned = _SLUG_STRIP.sub("", str(value).strip().lower())
    return _SLUG_COLLAPSE.sub("-", cleaned).strip("-")


class CityData:
    """Retrieve the current Inside Airbnb city and dataset catalogue."""

    EXPLORE_URL = "https://insideairbnb.com/explore/"
    DATA_URL = "https://insideairbnb.com/get-the-data/"
    DEFAULT_FIXTURE_PATH = (
        Path(__file__).parent / "fixtures" / "insideairbnb_cities.json"
    )

    APP_LABEL = "listings"

    # Country-wide archives that appear on the data page but not on Explore.
    COUNTRY_CONTINENT_OVERRIDES = {
        "Malta": "Europe",
        "New Zealand": "Asia-Pacific",
    }

    URL_FIELD_SUFFIXES = ("_csv_gz", "_csv", "_geojson")

    # Fields that belong to Country / Continent, not City — skip on copy.
    _CITY_SKIP_FIELDS = frozenset(
        {
            "continent",
            "country",
            "country_slug",
            "city",
            "city_slug",
            "region",
            "is_country_archive",
        }
    )

    def __init__(self, *, timeout: float = 30.0) -> None:
        self.timeout = timeout
        self.continent_dict = self.scrape_continent_country_dict()
        self.all_cities: list[dict[str, Any]] = []

    # ------------------------------------------------------------------ HTTP

    def _get_soup(self, url: str) -> BeautifulSoup:
        response = requests.get(url, timeout=self.timeout, impersonate="chrome")
        response.raise_for_status()
        return BeautifulSoup(response.content, "html.parser")

    # --------------------------------------------------------------- Explore

    def scrape_continent_country_dict(self) -> dict[str, list[str]]:
        """Return the continent-to-country mapping displayed on Explore."""
        soup = self._get_soup(self.EXPLORE_URL)
        continents: dict[str, list[str]] = {}

        for container in soup.select("div.continentContainer"):
            continent: str | None = None
            for paragraph in container.find_all("p", recursive=False):
                classes = set(paragraph.get("class", []))
                label = paragraph.get_text(" ", strip=True)

                if "continentLabel" in classes:
                    continent = label
                    continents.setdefault(continent, [])
                elif "countryLabel" in classes and continent:
                    continents[continent].append(label)

        if not continents:
            raise RuntimeError("Could not find continent data on the Explore page.")

        for country, continent in self.COUNTRY_CONTINENT_OVERRIDES.items():
            continents.setdefault(continent, []).append(country)

        return continents

    # ------------------------------------------------------------- Data page

    @staticmethod
    def _parse_location(label: str) -> tuple[str, str | None, str, bool]:
        """Parse a data-page heading into city, region, country, archive flag."""
        parts = [part.strip() for part in label.rsplit(",", maxsplit=2)]

        if len(parts) == 3:
            city, region, country = parts
            return city, region, country, False

        if len(parts) == 1 and parts[0]:
            return parts[0], None, parts[0], True

        raise ValueError(f"Unexpected Inside Airbnb location heading: {label!r}")

    def _country_to_continent(self) -> dict[str, str]:
        return {
            country: continent
            for continent, countries in self.continent_dict.items()
            for country in countries
        }

    def create_city_df(self) -> pd.DataFrame:
        """Return one DataFrame row per location, with a URL column per file."""
        country_to_continent = self._country_to_continent()
        soup = self._get_soup(self.DATA_URL)
        records: list[dict[str, Any]] = []

        for table in soup.select("table.data"):
            heading = table.find_previous("h3")
            if heading is None:
                continue

            city, region, country, is_country_archive = self._parse_location(
                heading.get_text(" ", strip=True)
            )
            try:
                continent = country_to_continent[country]
            except KeyError as error:
                raise RuntimeError(
                    f"{country!r} appears on the data page but has no continent "
                    "mapping. Add it to COUNTRY_CONTINENT_OVERRIDES."
                ) from error

            record: dict[str, Any] = {
                "continent": continent,
                "country": country,
                "country_slug": _slugify(country),
                "city": city,
                "city_slug": _slugify(city) if city else None,
                "region": region,
                "is_country_archive": is_country_archive,
            }
            for link in table.select("a[href]"):
                url = link["href"]
                filename = urlparse(url).path.rsplit("/", maxsplit=1)[-1]
                if filename:
                    record.setdefault(filename.replace(".", "_"), url)

            if "listings_csv" in record:
                records.append(record)

        if not records:
            raise RuntimeError(
                "No locations with listings.csv were found on the data page."
            )

        self.all_cities = records
        return (
            pd.DataFrame(records)
            .sort_values(["continent", "country", "city"], kind="stable")
            .reset_index(drop=True)
        )

    # -------------------------------------------------------------- Fixtures

    @staticmethod
    def _json_value(value: Any) -> Any:
        if pd.isna(value):
            return None
        return value.item() if hasattr(value, "item") else value

    def create_django_fixtures(self) -> list[dict[str, Any]]:
        """Return the full catalogue as one ordered Django fixture list."""
        cities = self.create_city_df()
        app = self.APP_LABEL
        fixture: list[dict[str, Any]] = []

        # --- Continents ----------------------------------------------------
        continent_names = sorted(cities["continent"].unique())
        continent_pks: dict[str, int] = {
            name: pk for pk, name in enumerate(continent_names, start=1)
        }
        for name, pk in continent_pks.items():
            fixture.append(
                {
                    "model": f"{app}.continent",
                    "pk": pk,
                    "fields": {
                        "name": name,
                        "slug": _slugify(name),
                        "display_order": pk,
                    },
                }
            )

        # --- Countries -----------------------------------------------------
        country_rows = (
            cities[["continent", "country"]]
            .drop_duplicates()
            .sort_values(["continent", "country"], kind="stable")
        )
        country_pks: dict[tuple[str, str], int] = {}
        for pk, row in enumerate(country_rows.to_dict(orient="records"), start=1):
            key = (row["continent"], row["country"])
            country_pks[key] = pk
            fixture.append(
                {
                    "model": f"{app}.country",
                    "pk": pk,
                    "fields": {
                        "name": row["country"],
                        "slug": _slugify(row["country"]),
                        "continent": continent_pks[row["continent"]],
                        "display_order": pk,
                    },
                }
            )

        # --- Cities --------------------------------------------------------
        cities_sorted = cities.sort_values(
            ["continent", "country", "city"], kind="stable"
        ).reset_index(drop=True)

        for pk, row in enumerate(cities_sorted.to_dict(orient="records"), start=1):
            country_key = (row["continent"], row["country"])
            city_slug = row.get("city_slug") or f"{_slugify(row['country'])}-archive"

            fields: dict[str, Any] = {
                "country": country_pks[country_key],
                "city": row.get("city"),
                "city_slug": city_slug,
                "region": row.get("region"),
                "is_country_archive": bool(row.get("is_country_archive", False)),
            }

            for key, value in row.items():
                if key in self._CITY_SKIP_FIELDS:
                    continue
                if any(key.endswith(suffix) for suffix in self.URL_FIELD_SUFFIXES):
                    fields[key] = self._json_value(value)

            fixture.append({"model": f"{app}.city", "pk": pk, "fields": fields})

        return fixture

    def split_fixtures(self) -> dict[str, list[dict[str, Any]]]:
        """Return the fixture grouped by model."""
        objs = self.create_django_fixtures()
        return {
            "continents": [o for o in objs if o["model"].endswith(".continent")],
            "countries": [o for o in objs if o["model"].endswith(".country")],
            "cities": [o for o in objs if o["model"].endswith(".city")],
        }

    # ------------------------------------------------------------------ Dump

    def dump_django_fixture(self, path: str | Path | None = None) -> Path:
        """Write a single combined fixture."""
        fixture_path = Path(path or self.DEFAULT_FIXTURE_PATH)
        fixture_path.parent.mkdir(parents=True, exist_ok=True)
        fixture_path.write_text(
            json.dumps(self.create_django_fixtures(), ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf-8",
        )
        return fixture_path

    def dump_split_fixtures(self, directory: str | Path | None = None) -> list[Path]:
        """Write three files — continents.json, countries.json, cities.json."""
        out_dir = Path(directory or self.DEFAULT_FIXTURE_PATH.parent)
        out_dir.mkdir(parents=True, exist_ok=True)

        paths: list[Path] = []
        for name, objs in self.split_fixtures().items():
            p = out_dir / f"{name}.json"
            p.write_text(
                json.dumps(objs, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            paths.append(p)
        return paths


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--split",
        action="store_true",
        help="Write three files (continents.json, countries.json, cities.json)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output file (combined) or directory (with --split)",
    )
    args = parser.parse_args()

    scraper = CityData()
    if args.split:
        for path in scraper.dump_split_fixtures(args.out):
            print(f"Wrote {path}")
    else:
        print(f"Wrote fixture to {scraper.dump_django_fixture(args.out)}")
