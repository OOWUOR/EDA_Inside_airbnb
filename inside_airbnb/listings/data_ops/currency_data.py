"""Build a currency-rate fixture from IBAN's currency table and Wise rates.

Produces a Django fixture for the ``listings.Currency`` model, one row per
ISO 4217 code.  Country-to-currency mapping is exposed via
``CurrencyData.country_code_map()`` for the ``attach_currencies`` management
command.
"""

from __future__ import annotations

import argparse
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd
from bs4 import BeautifulSoup
from curl_cffi import requests

CURRENCY_PAGE = "https://www.iban.com/currency-codes"
WISE_URL = "https://wise.com/gb/currency-converter/usd-to-{code}-rate?amount=1"


class CurrencyData:
    """Scrape IBAN + Wise and emit a Django fixture of Currency rows."""

    DEFAULT_FIXTURE_PATH = Path(__file__).parent.parent / "fixtures" / "currencies.json"
    APP_LABEL = "listings"

    # Substring rules applied in order to the *lowercased* IBAN country name.
    # First match wins.  These mirror the corrections the original script
    # hard-coded with ``str.contains``.
    SUBSTRING_ALIASES: tuple[tuple[str, str], ...] = (
        ("netherlands", "The Netherlands"),
        ("taiwan", "Taiwan"),
        ("czech", "Czech Republic"),
        ("united kingdom", "United Kingdom"),
        ("united states", "United States"),
    )

    # Long-form IBAN names that don't contain the above substrings but still
    # need remapping.  Keys are exact (lowercased + stripped).
    EXACT_ALIASES: dict[str, str] = {
        "korea, republic of": "South Korea",
        "korea, democratic people's republic of": "North Korea",
        "russian federation": "Russia",
        "viet nam": "Vietnam",
        "bolivia, plurinational state of": "Bolivia",
        "venezuela, bolivarian republic of": "Venezuela",
        "iran, islamic republic of": "Iran",
        "syrian arab republic": "Syria",
        "lao people's democratic republic": "Laos",
        "brunei darussalam": "Brunei",
        "hong kong": "Hong Kong",
        "macao": "Macao",
        "moldova, republic of": "Moldova",
        "tanzania, united republic of": "Tanzania",
        "macedonia, the former yugoslav republic of": "North Macedonia",
    }

    def __init__(self, *, timeout: float = 20.0) -> None:
        self.timeout = timeout

    # --------------------------------------------------------------- HTTP

    def _get(self, url: str) -> requests.Response:
        r = requests.get(url, timeout=self.timeout, impersonate="chrome")
        r.raise_for_status()
        return r

    def _soup(self, url: str) -> BeautifulSoup:
        return BeautifulSoup(self._get(url).content, "html.parser")

    # ---------------------------------------------------------- IBAN table

    def scrape_country_currency(self) -> list[tuple[str, str]]:
        """Return (country, currency_code) pairs from the IBAN page."""
        soup = self._soup(CURRENCY_PAGE)
        table = soup.find("table", class_="table")
        if not table:
            raise RuntimeError("Currency table not found on IBAN page.")

        out: list[tuple[str, str]] = []
        for row in table.find_all("tr"):
            cells = row.find_all("td")
            if len(cells) < 4:
                continue
            country = cells[0].get_text(strip=True)
            code = cells[2].get_text(strip=True)
            if not code:  # "No universal currency" rows
                continue
            out.append((country, code))
        return out

    # --------------------------------------------------------------- Wise

    def get_usd_rate(self, code: str) -> Decimal | None:
        """Return the Wise 'USD → code' rate (i.e. 1 USD = X code), or None."""
        url = WISE_URL.format(code=code.lower())
        try:
            soup = self._soup(url)
            tag = soup.find("input", id="target-input")
            if tag and tag.get("value"):
                raw = tag["value"].replace(",", "").strip()
                return Decimal(raw)
        except Exception as exc:
            print(f"[warn] {code}: {type(exc).__name__}: {exc}")
        return None

    # ----------------------------------------------------- Country naming

    @classmethod
    def _normalise_country(cls, raw: str) -> str:
        """Map an IBAN country name to the name our Country model uses."""
        key = raw.strip().lower()

        # Exact alias first (more specific), then substring rules.
        if key in cls.EXACT_ALIASES:
            return cls.EXACT_ALIASES[key]
        for needle, canonical in cls.SUBSTRING_ALIASES:
            if needle in key:
                return canonical
        return raw.strip().title()

    # ---------------------------------------------------------- DataFrame

    def create_df(self) -> pd.DataFrame:
        """One row per country with its currency code and USD rate."""
        pairs = self.scrape_country_currency()
        codes = sorted({c for _, c in pairs})
        rates = {c: self.get_usd_rate(c) for c in codes}

        # USD is its own reference rate; don't trust scraping it.
        rates["USD"] = Decimal(1)

        rows: list[dict[str, Any]] = []
        for country, code in pairs:
            name = self._normalise_country(country)

            # Any "United States*" entry gets forced to USD at 1.0 — mirrors
            # the original script's ``value_usd = 1`` override.
            if "united states" in country.lower():
                code = "USD"

            rate = rates.get(code)
            if rate is None:
                continue

            rows.append({"country": name, "code": code, "value_usd": rate})

        df = pd.DataFrame(rows).drop_duplicates(subset=["country"], keep="first")
        return df.sort_values("country", kind="stable").reset_index(drop=True)

    # ------------------------------------------------------------- Fixture

    def create_django_fixture(self) -> list[dict[str, Any]]:
        """Return a fixture list with one Currency row per unique code."""
        df = self.create_df()

        # Guard: USD is always the reference, no matter what upstream said.
        df.loc[df["code"] == "USD", "value_usd"] = Decimal(1)

        rates = (
            df[["code", "value_usd"]]
            .drop_duplicates(subset=["code"], keep="first")
            .sort_values("code", kind="stable")
            .reset_index(drop=True)
        )
        return [
            {
                "model": f"{self.APP_LABEL}.currency",
                "pk": pk,
                "fields": {
                    "code": row["code"],
                    # DecimalField wants a string in JSON.
                    "value_usd": str(row["value_usd"]),
                },
            }
            for pk, row in enumerate(rates.to_dict(orient="records"), start=1)
        ]

    def dump_fixture(self, path: str | Path | None = None) -> Path:
        out = Path(path or self.DEFAULT_FIXTURE_PATH)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(self.create_django_fixture(), ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf-8",
        )
        return out

    # ------------------------------------------------------ Country lookup

    def country_code_map(self) -> dict[str, str]:
        """Return {country_name: currency_code} for the country-attach step."""
        df = self.create_df()
        return dict(zip(df["country"], df["code"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=None, help="Output fixture path.")
    parser.add_argument(
        "--map",
        action="store_true",
        help="Print the country→currency map instead of writing.",
    )
    args = parser.parse_args()

    scraper = CurrencyData()
    if args.map:
        for country, code in sorted(scraper.country_code_map().items()):
            print(f"{country:40s} {code}")
    else:
        print(f"Wrote fixture to {scraper.dump_fixture(args.out)}")
