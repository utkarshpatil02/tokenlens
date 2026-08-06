"""Freeze the Python analysis payload as a cross-implementation fixture.

Same purpose as `export_pricing_golden.py`, one layer up. The aggregation rules
are full of small decisions that are easy to port *almost* right — which token
categories get filtered out, how ties in per-model cost are ordered, whether a
whitespace-only prompt counts as scorable, how a share is rounded — and every one
of them changes a number on the dashboard without changing its shape.

Also exported: a set of `round()` results. Python rounds halves to even and
JavaScript rounds them away from zero, so a share of exactly 5/32 comes out
0.1562 here and 0.1563 there unless the port emulates it. These cases pin that
down directly rather than waiting for it to surface as a mysterious one-digit
difference.

The waste section is null throughout: scoring is not ported yet, and this fixture
covers the spend half that needs no classification.

Usage:
    python scripts/export_analysis_golden.py [--check]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tokenlens.analysis import Analysis  # noqa: E402
from tokenlens.models import Call, Profile, Turn  # noqa: E402
from tokenlens.pricing import TOKEN_CATEGORIES, default_table  # noqa: E402
from tokenlens.scoring import BloatBaseline  # noqa: E402

TARGET = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "engine"
    / "__fixtures__"
    / "analysis-golden.json"
)

DURING_PROMO = datetime(2026, 7, 26, tzinfo=timezone.utc)
AFTER_PROMO = datetime(2026, 9, 1, tzinfo=timezone.utc)

# Values chosen to sit on or near a rounding boundary. The dyadic ones
# (0.125, 0.15625, 0.0625) are exactly representable, so they are true ties and
# are where half-to-even and half-away-from-zero actually disagree.
ROUNDING_CASES = [
    (0.125, 2),
    (0.375, 2),
    (0.15625, 4),
    (0.0625, 3),
    (2.5, 0),
    (3.5, 0),
    (0.5, 0),
    (1.5, 0),
    (-0.125, 2),
    (-2.5, 0),
    (2.675, 2),
    (8.955, 2),
    (1 / 3, 4),
    (2 / 3, 4),
    (0.0001499, 4),
    (0.00005, 4),
    (123.456789, 2),
    (0.0, 4),
]


def call(model: str, when: datetime | None = AFTER_PROMO, **tokens) -> Call:
    return Call(model=model, timestamp=when, **tokens)


def turn(
    turn_id: str,
    calls: list[Call],
    prompt: str | None = None,
    session: str | None = None,
    profile: Profile = Profile.AGENTIC,
) -> Turn:
    return Turn(
        turn_id=turn_id,
        profile=profile,
        timestamp=min(
            (c.timestamp for c in calls if c.timestamp), default=AFTER_PROMO
        ),
        calls=calls,
        prompt_text=prompt,
        session_id=session,
    )


def rich_turns() -> list[Turn]:
    """A spread wide enough to exercise every aggregation rule at once."""
    return [
        # Multi-call turn, both cache TTLs present.
        turn(
            "t1",
            [
                call("claude-sonnet-4-6", input_tokens=12, output_tokens=286,
                     cache_read=34_488, cache_write_1h=12_359),
                call("claude-sonnet-4-6", output_tokens=1_204, cache_read=46_847,
                     cache_write_5m=2_048),
                call("claude-sonnet-4-6", output_tokens=318, cache_read=58_203),
            ],
            prompt="port the pricing engine to TypeScript",
            session="s1",
        ),
        turn("t2", [call("claude-haiku-4-5", input_tokens=120, output_tokens=88)],
             prompt="rename a variable", session="s1"),
        # No prompt text at all: counts toward spend, not toward scorable turns.
        turn(
            "t3",
            [
                call("claude-sonnet-5", when=DURING_PROMO, output_tokens=940,
                     cache_read=29_115, cache_write_5m=8_800),
                call("claude-sonnet-5", when=DURING_PROMO, output_tokens=612,
                     cache_read=33_901),
            ],
            session="s2",
        ),
        # Same model, outside the promotional window.
        turn(
            "t4",
            [
                call("claude-sonnet-5", output_tokens=940, cache_read=29_115),
                call("claude-sonnet-5", output_tokens=612, cache_read=33_901),
            ],
            prompt="write tests for the CSV reader",
            session="s2",
        ),
        # No session id: must not be counted as a session.
        turn(
            "t5",
            [call("gpt-4o", input_tokens=800, output_tokens=200) for _ in range(5)],
            prompt="explain prompt caching",
        ),
        # Whitespace-only prompt is not scorable.
        turn("t6", [call("gpt-4o-mini", input_tokens=40, output_tokens=10)],
             prompt="   ", session="s3"),
        # t7 and t8 cost exactly the same: Opus 5 and Opus 4.8 are priced
        # identically, so per-model ordering falls back to first-seen order and
        # a port that sorts unstably will disagree here.
        turn("t7", [call("claude-opus-5", input_tokens=1_000, output_tokens=500)],
             prompt="tie-break case A", session="s3"),
        turn("t8", [call("claude-opus-4-8", input_tokens=1_000, output_tokens=500)],
             prompt="tie-break case B", session="s3"),
    ]


def sparse_turns() -> list[Turn]:
    """Only output tokens, so every other category is filtered out entirely."""
    return [turn("only", [call("claude-haiku-4-5", output_tokens=1_000)],
                 prompt="one line", session="s1")]


CASES: list[tuple[str, list[Turn]]] = [
    ("rich spread", rich_turns()),
    ("output tokens only", sparse_turns()),
    ("no turns at all", []),
]


def serialize_turn(item: Turn) -> dict:
    return {
        "turn_id": item.turn_id,
        "profile": item.profile.value,
        "timestamp": item.timestamp.isoformat() if item.timestamp else None,
        "prompt_text": item.prompt_text,
        "session_id": item.session_id,
        "calls": [
            {
                "model": c.model,
                "timestamp": c.timestamp.isoformat() if c.timestamp else None,
                **{category: getattr(c, category) for category in TOKEN_CATEGORIES},
            }
            for c in item.calls
        ],
    }


def build() -> dict:
    table = default_table()
    cases = []

    for name, turns in CASES:
        payload = Analysis(
            turns=turns,
            classifications={},
            scores=[],
            table=table,
            baseline=BloatBaseline.from_turns(turns, {}),
        ).to_payload()

        # Wall-clock, so it can never match across implementations and has no
        # business in a comparison.
        payload.pop("generated_at")

        cases.append(
            {
                "name": name,
                "turns": [serialize_turn(t) for t in turns],
                "payload": payload,
            }
        )

    return {
        "cases": cases,
        "rounding": [
            {"value": repr(value), "digits": digits, "expected": repr(round(value, digits))}
            for value, digits in ROUNDING_CASES
        ],
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
                f"{TARGET} is out of date; re-run scripts/export_analysis_golden.py",
                file=sys.stderr,
            )
            return 1
        print(f"{TARGET.name} is current")
        return 0

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(rendered, encoding="utf-8")
    print(f"wrote {TARGET} ({len(CASES)} cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
