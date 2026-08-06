"""Freeze the Python cost engine's output as a cross-implementation fixture.

There are now two implementations of the same pricing rules — `tokenlens.pricing`
and `frontend/src/engine/pricing.ts` — and the failure mode that matters is not
one of them crashing, it is the two of them quietly disagreeing so that the CLI
and the web app report different dollar figures for the same log with nothing to
say which is right.

This writes what Python computes for a spread of calls. The TypeScript suite
reads the same file and has to reproduce every figure. Neither side can drift
without a red test.

Costs are written with `format(value, "f")` — the same serialization the API
uses — so the fixture is compared numerically, not as strings. `Decimal` carries
an exponent that survives into its text form ("39.995350"), which is a property
of Python's arithmetic rather than of the money, and holding the port to it
would be testing the wrong thing.

Usage:
    python scripts/export_pricing_golden.py [--check]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tokenlens.models import Call  # noqa: E402
from tokenlens.pricing import TOKEN_CATEGORIES, default_table  # noqa: E402

TARGET = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "engine"
    / "__fixtures__"
    / "pricing-golden.json"
)

# The capability tiers the table prices against: 1 small, 2 mid, 3 frontier.
TIERS = (1, 2, 3)

DURING_PROMO = datetime(2026, 7, 26, tzinfo=timezone.utc)
AFTER_PROMO = datetime(2026, 9, 1, tzinfo=timezone.utc)
PROMO_LAST_MOMENT = datetime(2026, 8, 31, 23, 59, 59, tzinfo=timezone.utc)

# A real agentic call: input near zero, cost carried by cache traffic and output.
AGENTIC = {
    "input_tokens": 2,
    "output_tokens": 286,
    "cache_read": 34_488,
    "cache_write_1h": 12_359,
}

CASES: list[tuple[str, str, datetime | None, dict]] = [
    # Every model in the table, on the same realistic call shape.
    *(
        (f"{model} agentic call", model, AFTER_PROMO, AGENTIC)
        for model in (
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
            "gpt-4o",
            "gpt-4o-mini",
        )
    ),
    # The promotional window, from both sides and on its exact boundary.
    ("sonnet inside promo window", "claude-sonnet-5", DURING_PROMO, AGENTIC),
    ("sonnet on final promo moment", "claude-sonnet-5", PROMO_LAST_MOMENT, AGENTIC),
    ("sonnet after promo window", "claude-sonnet-5", AFTER_PROMO, AGENTIC),
    ("sonnet with unknown date", "claude-sonnet-5", None, AGENTIC),
    # Prefix fallbacks, including the longest-wins pair.
    ("unlisted opus point version", "claude-opus-9-9", AFTER_PROMO, AGENTIC),
    ("unlisted gpt-4o-mini version", "gpt-4o-mini-2099", AFTER_PROMO, AGENTIC),
    ("unlisted gpt-4o version", "gpt-4o-2099", AFTER_PROMO, AGENTIC),
    # Shapes that have caused trouble before.
    ("zero token call", "claude-opus-5", AFTER_PROMO, {}),
    ("single token", "claude-haiku-4-5", AFTER_PROMO, {"input_tokens": 3}),
    (
        "every category at once",
        "claude-opus-5",
        AFTER_PROMO,
        {
            "input_tokens": 995,
            "output_tokens": 392_738,
            "cache_read": 144_867_214,
            "cache_write_5m": 7_331,
            "cache_write_1h": 4_146_598,
        },
    ),
    (
        "both cache TTLs",
        "claude-sonnet-4-6",
        AFTER_PROMO,
        {"cache_write_5m": 40_000, "cache_write_1h": 60_000},
    ),
]


def build() -> dict:
    table = default_table()
    cases = []

    for name, model, when, tokens in CASES:
        call = Call(model=model, timestamp=when, **tokens)
        breakdown = table.cost_breakdown(call)
        rates = table.rates_for(model, at=when)

        cases.append(
            {
                "name": name,
                "model": model,
                "timestamp": when.isoformat() if when else None,
                "tokens": {
                    category: getattr(call, category) for category in TOKEN_CATEGORIES
                },
                "resolved_model": table.resolve(model),
                "tier": rates.tier,
                "promotional": rates.promotional,
                "cost": format(table.cost_of(call), "f"),
                "breakdown": {
                    category: format(value, "f") for category, value in breakdown.items()
                },
                "cost_at_tier": {
                    str(tier): format(table.cost_at_tier(call, tier), "f")
                    for tier in TIERS
                },
            }
        )

    # Guard the guard: a fixture whose components do not sum to their total would
    # bake the very bug it exists to catch into every future comparison.
    for case in cases:
        total = sum((Decimal(v) for v in case["breakdown"].values()), Decimal(0))
        if total != Decimal(case["cost"]):
            raise AssertionError(f"{case['name']}: breakdown does not sum to cost")

    return {
        "rate_table": {
            "version": table.version,
            "updated": table.updated.isoformat(),
            "currency": table.currency,
        },
        "cases": cases,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the committed fixture is stale instead of rewriting it",
    )
    args = parser.parse_args()

    rendered = json.dumps(build(), indent=2) + "\n"

    if args.check:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current != rendered:
            print(
                f"{TARGET} is out of date; re-run scripts/export_pricing_golden.py",
                file=sys.stderr,
            )
            return 1
        print(f"{TARGET.name} is current")
        return 0

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(rendered, encoding="utf-8")
    print(f"wrote {TARGET} ({len(build()['cases'])} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
