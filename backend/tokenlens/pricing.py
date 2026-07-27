"""Cache-aware cost engine.

Real agentic usage is dominated by cache traffic, not fresh input: across the
reference dataset, cache reads were 45% of spend, output 28%, cache writes 27%,
and uncached input 0.0%. A cost engine that only prices `input_tokens` and
`output_tokens` is therefore not slightly off, it is wrong by orders of
magnitude. Every token category is priced separately here, and cache writes are
split by TTL because the 1-hour tier costs 2x base against the 5-minute tier's
1.25x.

Money is `Decimal` throughout. Rates come from `pricing.yaml`, which is dated
and versioned so a figure can always be traced to the table that produced it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

import yaml

from tokenlens.models import Call

# The token categories the engine prices. Each maps to an attribute on `Call`
# and a rate key in the table, which keeps the two in lockstep.
TOKEN_CATEGORIES = (
    "input_tokens",
    "output_tokens",
    "cache_read",
    "cache_write_5m",
    "cache_write_1h",
)

_RATE_KEY = {
    "input_tokens": "input",
    "output_tokens": "output",
    "cache_read": "cache_read",
    "cache_write_5m": "cache_write_5m",
    "cache_write_1h": "cache_write_1h",
}

_PER_MILLION = Decimal(1_000_000)

DEFAULT_TABLE = Path(__file__).with_name("pricing.yaml")


class UnknownModelError(KeyError):
    """Raised when a model has no rate entry and no prefix fallback.

    Deliberately loud: silently pricing an unknown model at zero would understate
    spend without any visible symptom.
    """


@dataclass(frozen=True, slots=True)
class Rates:
    """Per-million-token rates for one model at one point in time."""

    model: str
    tier: int
    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write_5m: Decimal
    cache_write_1h: Decimal
    promotional: bool = False

    def rate_for(self, category: str) -> Decimal:
        return getattr(self, _RATE_KEY[category])


class PriceTable:
    """A loaded, dated rate table."""

    def __init__(self, data: dict):
        self.version: int = data["version"]
        self.updated: date = _as_date(data["updated"])
        self.currency: str = data.get("currency", "USD")
        self._models: dict[str, dict] = data["models"]
        self._tier_reference: dict[int, str] = {
            int(tier): model for tier, model in data.get("tier_reference", {}).items()
        }
        # Longest prefix first, so `gpt-4o-mini` wins over `gpt-4o`.
        self._prefixes: list[tuple[str, str]] = sorted(
            data.get("prefix_fallbacks", {}).items(),
            key=lambda kv: len(kv[0]),
            reverse=True,
        )

    @classmethod
    def load(cls, path: Path | str = DEFAULT_TABLE) -> PriceTable:
        with open(path, encoding="utf-8") as handle:
            return cls(yaml.safe_load(handle))

    def resolve(self, model: str) -> str:
        """Map a model id to the table entry that prices it."""
        if model in self._models:
            return model
        for prefix, target in self._prefixes:
            if model.startswith(prefix):
                return target
        raise UnknownModelError(
            f"no rate entry or prefix fallback for model {model!r}; "
            f"add it to the rate table (version {self.version}, "
            f"updated {self.updated})"
        )

    def rates_for(self, model: str, at: datetime | date | None = None) -> Rates:
        """Rates for `model`, applying any promotional window active at `at`.

        `at` is the moment the call was billed. When it is unknown, list rates
        apply — a time-limited discount is never assumed, since guessing wrong
        understates real spend.
        """
        entry = self._models[self.resolve(model)]
        promo = entry.get("promotional")
        use_promo = False

        if promo and at is not None:
            when = at.date() if isinstance(at, datetime) else at
            use_promo = when <= _as_date(promo["until"])

        source = {**entry, **promo} if use_promo else entry
        return Rates(
            model=model,
            tier=int(entry["tier"]),
            input=_as_decimal(source["input"]),
            output=_as_decimal(source["output"]),
            cache_read=_as_decimal(source["cache_read"]),
            cache_write_5m=_as_decimal(source["cache_write_5m"]),
            cache_write_1h=_as_decimal(source["cache_write_1h"]),
            promotional=use_promo,
        )

    def tier_of(self, model: str) -> int:
        return int(self._models[self.resolve(model)]["tier"])

    def cost_of(self, call: Call) -> Decimal:
        """Total cost of one call, summed across every token category."""
        rates = self.rates_for(call.model, at=call.timestamp)
        return sum(
            (
                _cost(getattr(call, category), rates.rate_for(category))
                for category in TOKEN_CATEGORIES
            ),
            Decimal(0),
        )

    def reference_model(self, tier: int) -> str:
        """The model a tier is priced against for counterfactual costing."""
        try:
            return self._tier_reference[tier]
        except KeyError:
            raise UnknownModelError(
                f"no reference model configured for tier {tier}"
            ) from None

    def cost_at_tier(self, call: Call, tier: int) -> Decimal:
        """What this call's tokens would have cost on the given tier.

        The whole call is repriced, not just its input, because output is a
        material share of cost and is charged at a different multiple on every
        model. Token counts are held constant: this answers "the same work on a
        cheaper model", not "a cheaper model would have produced less".
        """
        substitute = Call(
            model=self.reference_model(tier),
            timestamp=call.timestamp,
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
            cache_read=call.cache_read,
            cache_write_5m=call.cache_write_5m,
            cache_write_1h=call.cache_write_1h,
        )
        return self.cost_of(substitute)

    def cost_breakdown(self, call: Call) -> dict[str, Decimal]:
        """Cost of one call split by token category.

        This is what makes the composition claim inspectable rather than
        asserted — the caller can show where the money actually went.
        """
        rates = self.rates_for(call.model, at=call.timestamp)
        return {
            category: _cost(getattr(call, category), rates.rate_for(category))
            for category in TOKEN_CATEGORIES
        }


def _cost(tokens: int, rate_per_million: Decimal) -> Decimal:
    if not tokens:
        return Decimal(0)
    return (Decimal(tokens) * rate_per_million) / _PER_MILLION


def _as_decimal(value) -> Decimal:
    # str() first: Decimal(float) would carry the float's binary error into
    # every downstream figure.
    return Decimal(str(value))


def _as_date(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


@lru_cache(maxsize=1)
def default_table() -> PriceTable:
    """The bundled rate table, loaded once."""
    return PriceTable.load()


def cost_of(call: Call) -> Decimal:
    return default_table().cost_of(call)


def cost_breakdown(call: Call) -> dict[str, Decimal]:
    return default_table().cost_breakdown(call)


def tier_of(model: str) -> int:
    return default_table().tier_of(model)
