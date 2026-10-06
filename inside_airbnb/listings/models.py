# Create your models here.
from django.db import models


class Currency(models.Model):
    """A currency and its rate against USD, for price normalisation."""

    code = models.CharField(max_length=3, unique=True)
    value_usd = models.DecimalField(max_digits=20, decimal_places=10)

    class Meta:
        ordering = ("code",)
        verbose_name = "Currency"
        verbose_name_plural = "Currencies"

    def __str__(self) -> str:
        return self.code

    def natural_key(self):
        return (self.code,)


class Continent(models.Model):
    """A simple Continent List"""

    name = models.CharField(max_length=32, unique=True)
    slug = models.SlugField(max_length=32, unique=True)
    display_order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ("display_order", "name")
        verbose_name = "Continent"
        verbose_name_plural = "Continents"

    def __str__(self) -> str:
        return self.name


class Country(models.Model):
    """A Country with respective continent and currency FKs"""

    name = models.CharField(max_length=100, unique=True)
    slug = models.SlugField(max_length=100, unique=True)
    continent = models.ForeignKey(
        Continent, on_delete=models.PROTECT, related_name="countries"
    )
    currency = models.ForeignKey(
        Currency,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="countries",
    )
    display_order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ("display_order", "name")
        constraints = [
            models.UniqueConstraint(
                fields=("continent", "slug"), name="uniq_country_slug_per_continent"
            ),
        ]
        verbose_name = "Country"
        verbose_name_plural = "Countries"

    def __str__(self) -> str:
        return self.name


class City(models.Model):
    """A location and the current Inside Airbnb download URLs for it."""

    country = models.ForeignKey(
        Country, on_delete=models.PROTECT, related_name="cities"
    )
    city = models.CharField(max_length=150, blank=True, null=True)
    city_slug = models.SlugField(max_length=150, unique=True)
    region = models.CharField(max_length=255, blank=True, null=True)
    is_country_archive = models.BooleanField(default=False)

    listings_csv_gz = models.URLField(max_length=500, blank=True, null=True)
    calendar_csv_gz = models.URLField(max_length=500, blank=True, null=True)
    reviews_csv_gz = models.URLField(max_length=500, blank=True, null=True)
    listings_csv = models.URLField(max_length=500)
    reviews_csv = models.URLField(max_length=500, blank=True, null=True)
    neighbourhoods_csv = models.URLField(max_length=500, blank=True, null=True)
    neighbourhoods_geojson = models.URLField(max_length=500, blank=True, null=True)

    class Meta:
        ordering = (
            "city",
            "country__continent",
            "country",
        )
        indexes = [
            models.Index(fields=("country", "city")),
        ]
        verbose_name = "City"
        verbose_name_plural = "Cities"

    def __str__(self) -> str:
        return f"{self.city}, {self.country.name}"
