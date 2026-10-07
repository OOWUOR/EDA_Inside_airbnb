"""Download Inside Airbnb datasets into the local dataset cache."""

from __future__ import annotations

import os
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from curl_cffi import requests
from django.core.management.base import BaseCommand, CommandError
from listings.data_ops.datasets import KINDS, cache_dir
from listings.models import City

TIMEOUT = 300
CHUNK = 64 * 1024
DEFAULT_WORKERS = 4


def _is_fresh(dest: Path, url: str) -> bool:
    """True if dest exists, is non-empty, and its .url sidecar matches."""
    if not dest.exists() or dest.stat().st_size == 0:
        return False
    meta = dest.with_suffix(dest.suffix + ".url")
    if not meta.exists():
        return False
    return meta.read_text(encoding="utf-8").strip() == url


def _download(url: str, dest: Path) -> int:
    """Stream url into dest atomically. Returns bytes written."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=".tmp-")
    os.close(fd)
    tmp = Path(tmp_name)

    size = 0
    response = requests.get(url, timeout=TIMEOUT, impersonate="chrome", stream=True)
    try:
        response.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in response.iter_content(chunk_size=CHUNK):
                if chunk:
                    fh.write(chunk)
                    size += len(chunk)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    finally:
        response.close()

    tmp.replace(dest)
    dest.with_suffix(dest.suffix + ".url").write_text(url, encoding="utf-8")
    return size


class Command(BaseCommand):
    help = "Download Inside Airbnb datasets into the local dataset cache."

    def add_arguments(self, parser):
        parser.add_argument(
            "--city", action="append", metavar="SLUG", help="City slug (repeatable)."
        )
        parser.add_argument(
            "--continent", metavar="SLUG", help="Restrict to a continent slug."
        )
        parser.add_argument(
            "--country", metavar="SLUG", help="Restrict to a country slug."
        )
        parser.add_argument(
            "--kind",
            action="append",
            choices=list(KINDS),
            help="Only sync these kinds (default: all).",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Re-download even if the local file is fresh.",
        )
        parser.add_argument(
            "--workers",
            type=int,
            default=DEFAULT_WORKERS,
            help=f"Parallel downloads (default: {DEFAULT_WORKERS}).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="List what would be downloaded, do nothing.",
        )
        parser.add_argument(
            "--precompute",
            action="store_true",
            help="After syncing, warm every aggregate cache.",
        )

    def handle(self, *args, **opts):
        kinds = tuple(opts["kind"] or KINDS)

        qs = City.objects.select_related("country", "country__continent")
        if opts["city"]:
            qs = qs.filter(city_slug__in=opts["city"])
        if opts["country"]:
            qs = qs.filter(country__slug=opts["country"])
        if opts["continent"]:
            qs = qs.filter(country__continent__slug=opts["continent"])

        cities = list(qs)
        if not cities:
            raise CommandError("No cities matched the given filters.")

        root = cache_dir()
        self.stdout.write(f"Cache dir: {root}")
        self.stdout.write(f"Cities:    {len(cities)}")
        self.stdout.write(f"Kinds:     {', '.join(kinds)}")
        self.stdout.write("")

        jobs = []  # (city, kind, url, dest)
        for city in cities:
            for kind in kinds:
                field, filename = KINDS[kind]
                url = getattr(city, field, None)
                if not url:
                    continue
                dest = root / city.city_slug / filename
                if not opts["force"] and _is_fresh(dest, url):
                    self.stdout.write(f"  [skip] {city.city_slug}/{kind} (fresh)")
                    continue
                jobs.append((city, kind, url, dest))

        if opts["dry_run"]:
            for city, kind, _url, dest in jobs:
                self.stdout.write(f"  [plan] {city.city_slug}/{kind} -> {dest}")
            self.stdout.write(f"\nDry run: {len(jobs)} download(s) planned.")
            return

        if not jobs:
            self.stdout.write(self.style.SUCCESS("Nothing to do."))
            return

        self.stdout.write(
            f"Downloading {len(jobs)} file(s) with {opts['workers']} worker(s)..."
        )
        failures = 0

        with ThreadPoolExecutor(max_workers=opts["workers"]) as pool:
            futures = {
                pool.submit(_download, url, dest): (city, kind, dest)
                for city, kind, url, dest in jobs
            }
            for fut in as_completed(futures):
                city, kind, dest = futures[fut]
                try:
                    size = fut.result()
                    self.stdout.write(
                        self.style.SUCCESS(
                            f"  [ok]   {city.city_slug}/{kind}  "
                            f"({size / 1024 / 1024:.1f} MB)"
                        )
                    )
                except Exception as exc:
                    failures += 1
                    self.stderr.write(
                        self.style.ERROR(
                            f"  [fail] {city.city_slug}/{kind}  "
                            f"{type(exc).__name__}: {exc}"
                        )
                    )

        if failures:
            raise CommandError(f"{failures} download(s) failed.")
        if opts.get("precompute"):
            from listings.datasets import precompute_cities

            self.stdout.write("")
            self.stdout.write(f"Precomputing aggregates for {len(cities)} cities...")

            def on_step(city, result, i, total):
                ok = sum(1 for v in result.values() if v == "ok")
                err = len(result) - ok
                tag = (
                    self.style.SUCCESS("ok")
                    if err == 0
                    else self.style.WARNING(f"{err} failed")
                )
                self.stdout.write(
                    f"  [{i:>3}/{total}] {city.city_slug:<32s} "
                    f"{ok}/{len(result)} ok  ({tag})"
                )

            precompute_cities(cities, callback=on_step)
        self.stdout.write(self.style.SUCCESS("Done."))
