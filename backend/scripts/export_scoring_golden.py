"""Freeze the Python waste payload as a cross-implementation fixture.

The unit tests ported into `score.test.ts` pin the scorer's behaviour one turn at
a time. This pins what happens when a whole corpus goes through it: the baselines
are derived from the corpus itself, so every turn's bloat figure depends on every
other turn, and a port that gets the median, the sample gating, or the
pair-to-complexity fallback subtly wrong produces a payload that is entirely
plausible and entirely different.

The corpus is built to reach every branch that only appears in aggregate:

* a (category, complexity) cell with enough samples for its own median
* a cell too thin for one, falling back to the complexity median
* a complexity too thin for either, so bloat is not measured at all
* busywork, which forfeits its whole cost
* a model below the required tier, which must be flagged and never scored
* a mix of hand labels and classifier output, so `source` is "mixed"
* an escalated classification whose complexity changed, for the flags block

Usage:
    python scripts/export_scoring_golden.py [--check]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tokenlens.analysis import Analysis  # noqa: E402
from tokenlens.classify.schema import Category, Classification, Complexity  # noqa: E402
from tokenlens.models import Call, Profile, Turn  # noqa: E402
from tokenlens.pricing import TOKEN_CATEGORIES, default_table  # noqa: E402
from tokenlens.scoring import BloatBaseline, Scorer, calls_baseline_from  # noqa: E402

TARGET = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "engine"
    / "__fixtures__"
    / "scoring-golden.json"
)

WHEN = datetime(2026, 9, 1, tzinfo=timezone.utc)

HAIKU = "claude-haiku-4-5"
SONNET = "claude-sonnet-5"
OPUS = "claude-opus-5"


def call(model: str, cache_read: int = 0, output_tokens: int = 500, **kw) -> Call:
    return Call(
        model=model,
        timestamp=WHEN,
        cache_read=cache_read,
        output_tokens=output_tokens,
        **kw,
    )


def turn(turn_id: str, calls: list[Call], prompt: str, session: str = "s1") -> Turn:
    return Turn(
        turn_id=turn_id,
        profile=Profile.AGENTIC,
        timestamp=WHEN,
        calls=calls,
        prompt_text=prompt,
        session_id=session,
    )


def label(
    category: Category,
    complexity: Complexity,
    confidence: float = 0.87,
    human: bool = False,
    escalated: bool = False,
    base_complexity: Complexity | None = None,
) -> Classification:
    return Classification(
        category=category,
        complexity=complexity,
        confidence=confidence,
        rationale=f"{complexity.value} {category.value} task",
        model=("human:reviewer" if human else "claude-haiku-4-5"),
        escalated=escalated,
        base_complexity=base_complexity,
    )


def corpus() -> tuple[list[Turn], dict[str, Classification]]:
    turns: list[Turn] = []
    found: dict[str, Classification] = {}

    def add(t: Turn, c: Classification) -> None:
        turns.append(t)
        found[t.turn_id] = c

    # --- coding/complex on Opus: correct tier, so bloat is the only component.
    # Six samples, so this cell gets its own median. The last is a big outlier.
    for index, cache in enumerate([30_000, 34_000, 36_000, 40_000, 44_000, 400_000]):
        add(
            turn(
                f"complex{index}",
                [call(OPUS, cache_read=cache, output_tokens=900) for _ in range(3)],
                f"refactor module {index} without changing behaviour",
            ),
            label(Category.CODING, Complexity.COMPLEX, human=index % 2 == 0),
        )

    # --- coding/trivial on Opus: overshoot from tier 3 down to tier 1.
    for index, cache in enumerate([5_000, 6_000, 7_000, 8_000, 9_000]):
        add(
            turn(
                f"trivial{index}",
                [call(OPUS, cache_read=cache, output_tokens=60)],
                f"rename variable {index}",
            ),
            label(Category.CODING, Complexity.TRIVIAL, confidence=0.935),
        )

    # --- writing/moderate and research/moderate: three each, so neither pair
    # reaches five, but "moderate" does — exercising the fallback.
    for index, cache in enumerate([12_000, 15_000, 90_000]):
        add(
            turn(
                f"writing{index}",
                [call(SONNET, cache_read=cache, output_tokens=700) for _ in range(2)],
                f"draft release notes {index}",
                session="s2",
            ),
            label(Category.WRITING, Complexity.MODERATE),
        )
    for index, cache in enumerate([13_000, 16_000, 18_000]):
        add(
            turn(
                f"research{index}",
                [call(SONNET, cache_read=cache, output_tokens=650) for _ in range(2)],
                f"compare caching strategies {index}",
                session="s2",
            ),
            label(
                Category.RESEARCH,
                Complexity.MODERATE,
                escalated=True,
                base_complexity=Complexity.TRIVIAL,
            ),
        )

    # --- summarization/trivial, one turn: the trivial complexity already has a
    # median from the coding turns, so this still gets a bloat figure.
    add(
        turn(
            "summary0",
            [call(HAIKU, cache_read=2_000, output_tokens=200)],
            "summarise this changelog",
            session="s3",
        ),
        label(Category.SUMMARIZATION, Complexity.TRIVIAL),
    )

    # --- busywork: forfeits the whole cost regardless of model.
    add(
        turn(
            "busywork0",
            [call(OPUS, cache_read=20_000, output_tokens=40)],
            "say thanks",
            session="s3",
        ),
        label(Category.BUSYWORK, Complexity.TRIVIAL),
    )

    # --- under-provisioned: Haiku on a complex task. Flagged, never scored.
    add(
        turn(
            "under0",
            [call(HAIKU, cache_read=35_000, output_tokens=800)],
            "design the migration plan",
            session="s3",
        ),
        label(Category.CODING, Complexity.COMPLEX, human=True),
    )

    # --- an unclassified turn: real spend, absent from every waste figure.
    turns.append(
        turn("unscored0", [call(SONNET, cache_read=5_000)], "no label for this one", "s3")
    )

    return turns, found


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


def serialize_classification(found: Classification) -> dict:
    return {
        "category": found.category.value,
        "complexity": found.complexity.value,
        "confidence": found.confidence,
        "rationale": found.rationale,
        "model": found.model,
        "escalated": found.escalated,
        "base_complexity": (
            found.base_complexity.value if found.base_complexity else None
        ),
    }


def serialize_score(score) -> dict:
    return {
        "turn_id": score.turn_id,
        "actual_cost": format(score.actual_cost, "f"),
        "overshoot_cost": format(score.overshoot_cost, "f"),
        "bloat_cost": format(score.bloat_cost, "f"),
        "estimated_waste": format(score.estimated_waste, "f"),
        "tier_used": score.tier_used,
        "tier_required": score.tier_required,
        "zero_value": score.zero_value,
        "under_provisioned": score.under_provisioned,
        "bloat_measured": score.bloat_measured,
        "excess_tokens": score.excess_tokens,
        "bloat_metric": score.bloat_metric,
        "call_count": score.call_count,
        "calls_baseline": score.calls_baseline,
        "normalized": score.normalized,
        "band": score.band.value,
        "turn_efficiency": score.turn_efficiency,
        "recommendation": score.recommendation,
    }


def thin_corpus() -> tuple[list[Turn], dict[str, Classification]]:
    """Too few comparable turns for any median.

    Without this the full corpus reports `unmeasured_bloat_turns` of zero, and a
    port that computed that field wrongly would pass unnoticed. Here every turn
    is unmeasured, so the field has to carry a real number.
    """
    turns: list[Turn] = []
    found: dict[str, Classification] = {}
    for index, cache in enumerate([9_000, 250_000, 11_000]):
        item = turn(
            f"thin{index}",
            [call(OPUS, cache_read=cache, output_tokens=120)],
            f"one-off task {index}",
        )
        turns.append(item)
        found[item.turn_id] = label(Category.CODING, Complexity.TRIVIAL)
    return turns, found


def build_case(name: str, turns: list[Turn], found: dict[str, Classification]) -> dict:
    table = default_table()
    baseline = BloatBaseline.from_turns(turns, found)
    calls_baseline = calls_baseline_from(turns, found)
    scorer = Scorer(baseline=baseline, table=table, calls_baseline=calls_baseline)
    scores = scorer.score_all(turns, found)

    payload = Analysis(
        turns=turns,
        classifications=found,
        scores=scores,
        table=table,
        baseline=baseline,
    ).to_payload()
    payload.pop("generated_at")

    return {
        "name": name,
        "turns": [serialize_turn(t) for t in turns],
        "classifications": {
            turn_id: serialize_classification(c) for turn_id, c in found.items()
        },
        "baseline": {
            "metric": baseline.metric,
            "min_samples": baseline.min_samples,
            "by_pair": {
                f"{category.value}|{complexity.value}": value
                for (category, complexity), value in baseline.by_pair.items()
            },
            "by_complexity": {
                complexity.value: value
                for complexity, value in baseline.by_complexity.items()
            },
            "sample_counts": {
                f"{category.value}|{complexity.value}": count
                for (category, complexity), count in baseline.sample_counts.items()
            },
        },
        "calls_baseline": {
            complexity.value: value for complexity, value in calls_baseline.items()
        },
        "scores": [serialize_score(s) for s in scores],
        "payload": payload,
    }


def build() -> dict:
    return {
        "cases": [
            build_case("full corpus", *corpus()),
            build_case("corpus too thin for a baseline", *thin_corpus()),
        ]
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
                f"{TARGET} is out of date; re-run scripts/export_scoring_golden.py",
                file=sys.stderr,
            )
            return 1
        print(f"{TARGET.name} is current")
        return 0

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(rendered, encoding="utf-8")
    cases = build()["cases"]
    total = sum(len(case["scores"]) for case in cases)
    print(f"wrote {TARGET} ({len(cases)} cases, {total} scores)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
