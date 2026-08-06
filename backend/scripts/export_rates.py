"""Emit the rate table as JSON for the browser engine.

`pricing.yaml` stays the single source of truth. The TypeScript engine cannot
read YAML at build time without adding a parser to the bundle, so the table is
exported to JSON and committed — the frontend builds without Python, but the
rates it uses can only have come from the one table.

Rates are written as *strings*. JSON numbers are IEEE doubles, and round-tripping
a rate through a float is exactly the precision loss the Decimal engine exists to
avoid. `str(value)` is used deliberately: it is the same conversion
`pricing._as_decimal` applies, so the exported rate is the rate Python prices.

Usage:
    python scripts/export_rates.py [--check]

`--check` verifies the committed JSON is current without writing, for CI.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

SOURCE = Path(__file__).resolve().parents[1] / "tokenlens" / "pricing.yaml"
TARGET = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "engine" / "rates.json"
)

RATE_KEYS = ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h")


def _rates(entry: dict) -> dict:
    return {key: str(entry[key]) for key in RATE_KEYS}


def build() -> dict:
    data = yaml.safe_load(SOURCE.read_text(encoding="utf-8"))

    models = {}
    for name, entry in data["models"].items():
        model = {"tier": int(entry["tier"]), **_rates(entry)}
        if promo := entry.get("promotional"):
            model["promotional"] = {
                "until": str(promo["until"]),
                **_rates(promo),
            }
        models[name] = model

    return {
        "version": data["version"],
        "updated": str(data["updated"]),
        "currency": data.get("currency", "USD"),
        "unit": data.get("unit", "per_million_tokens"),
        "models": models,
        "tier_reference": {
            str(tier): model for tier, model in data.get("tier_reference", {}).items()
        },
        "prefix_fallbacks": dict(data.get("prefix_fallbacks", {})),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the committed JSON is stale instead of rewriting it",
    )
    args = parser.parse_args()

    rendered = json.dumps(build(), indent=2) + "\n"

    if args.check:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current != rendered:
            print(
                f"{TARGET} is out of date with {SOURCE.name}; "
                "re-run scripts/export_rates.py",
                file=sys.stderr,
            )
            return 1
        print(f"{TARGET.name} is current")
        return 0

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(rendered, encoding="utf-8")
    print(f"wrote {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
