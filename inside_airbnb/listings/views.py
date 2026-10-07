# Create your views here.
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404, render
from django.views.generic import ListView

from .data_ops.datasets import (compute_city_amenities,
                               compute_city_availability, compute_city_charts,
                               compute_city_hosts, compute_city_reviews,
                               compute_city_stats, compute_city_superlatives,
                               datasets_as_json, load_city_datasets)

from .models import City, Continent, Country


class CityListView(ListView):
    """City catalogue with continent → country → city drill-down.

    Three states, keyed off which GET params are present:

      * ``?``                                 — nothing selected → empty state
      * ``?country=<slug>``                   — country selected → city picker
      * ``?country=<slug>&city=<slug>``       — city selected → full dashboard

    Per-city aggregates (stats, charts, reviews, hosts, availability,
    superlatives, amenities) are read from cache.  Warm every entry ahead
    of the first request with ``python manage.py precompute_cities``.
    """

    model = City
    template_name = "listings/cities.html"
    context_object_name = "cities"

    # ---------------------------------------------------------------- helpers
    def _continent_slug(self):
        return self.request.GET.get("continent") or None

    def _country_slug(self):
        return self.request.GET.get("country") or None

    def _city_slug(self):
        return self.request.GET.get("city") or None

    def _search_query(self):
        return (self.request.GET.get("q") or "").strip() or None

    # ---------------------------------------------------------------- queryset
    def get_queryset(self):
        """Base queryset — only used for the header count."""
        qs = super().get_queryset()

        if s := self._continent_slug():
            qs = qs.filter(country__continent__slug=s)
        if s := self._country_slug():
            qs = qs.filter(country__slug=s)
        if q := self._search_query():
            qs = qs.filter(
                Q(city__icontains=q)
                | Q(region__icontains=q)
                | Q(country__name__icontains=q)
            )
        return qs

    # ---------------------------------------------------------------- context
    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)

        continent_slug = self._continent_slug()
        country_slug = self._country_slug()
        city_slug = self._city_slug()
        search_query = self._search_query()

        # ── Sidebar: continent chips ────────────────────────────────
        ctx["continents"] = Continent.objects.order_by("display_order", "name")

        # ── Sidebar: country list (annotated with city counts) ──────
        countries_qs = (
            Country.objects.select_related("continent")
            .annotate(city_count=Count("cities", distinct=True))
            .order_by("continent__display_order", "display_order", "name")
        )
        if continent_slug:
            countries_qs = countries_qs.filter(continent__slug=continent_slug)
        ctx["countries"] = countries_qs

        # ── Selection state ─────────────────────────────────────────
        ctx["selected_continent"] = continent_slug
        ctx["selected_country"] = country_slug
        ctx["selected_city"] = city_slug
        ctx["search_query"] = search_query

        # ── State 2: country picked, no city yet → city picker ──────
        if not city_slug:
            cities_qs = City.objects.select_related("country").order_by("city")
            if continent_slug:
                cities_qs = cities_qs.filter(country__continent__slug=continent_slug)
            if country_slug:
                cities_qs = cities_qs.filter(country__slug=country_slug)
            if search_query:
                cities_qs = cities_qs.filter(
                    Q(city__icontains=search_query) | Q(region__icontains=search_query)
                )
            ctx["country_cities"] = cities_qs

            if country_slug:
                ctx["selected_country_obj"] = get_object_or_404(
                    Country, slug=country_slug
                )

        # ── Top bar: grand total ────────────────────────────────────
        ctx["total_cities"] = City.objects.count()

        # ── State 3: city selected → full dashboard ─────────────────
        if city_slug:
            city = get_object_or_404(
                City.objects.select_related("country__currency"),
                city_slug=city_slug,
            )
            ctx["city_obj"] = city

            # Dataset previews for the map / JSON blocks
            raw = load_city_datasets(city)
            ctx["city_datasets"] = raw
            ctx["city_datasets_json"] = datasets_as_json(raw)

            # Aggregates (all cached, all precompute-friendly)
            ctx["city_stats"] = compute_city_stats(city)
            ctx["city_charts"] = compute_city_charts(city)
            ctx["city_reviews"] = compute_city_reviews(city)
            ctx["city_hosts"] = compute_city_hosts(city)
            ctx["city_availability"] = compute_city_availability(city)
            ctx["city_superlatives"] = compute_city_superlatives(city)
            ctx["city_amenities"] = compute_city_amenities(city)

        return ctx
