"""Bloat baselines.

Bloat is "more tokens than this kind of task warrants", which requires knowing
what comparable tasks cost. That reference is computed from the corpus being
scored rather than invented, so the claim is always "large relative to your own
comparable work" and never a number pulled from nowhere.

Which token category counts as bloat depends on the source profile. For
single-shot logs it is the prompt itself: an oversized `input_tokens`. For
agentic logs, `input_tokens` is ~0% of spend and the real waste is context
dragged through the cache on every call of the loop, so `cache_read` is the
measure. Using the single-shot definition on agentic data would report zero
bloat for every record no matter how bloated.

A cell with too few samples yields no baseline at all. A median over two turns
is not a distribution, and a bloat figure derived from one would be noise
presented as a finding.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from statistics import median

from tokenlens.classify.schema import Category, Classification, Complexity
from tokenlens.models import Profile, Turn

# The token category that carries bloat, per profile.
BLOAT_METRIC: dict[Profile, str] = {
    Profile.SIMPLE: "input_tokens",
    Profile.AGENTIC: "cache_read",
}

# Below this many comparable turns, no bloat baseline is claimed.
DEFAULT_MIN_SAMPLES = 5


@dataclass(slots=True)
class BloatBaseline:
    """Median bloat-metric tokens for comparable work."""

    min_samples: int = DEFAULT_MIN_SAMPLES
    by_pair: dict[tuple[Category, Complexity], float] = field(default_factory=dict)
    by_complexity: dict[Complexity, float] = field(default_factory=dict)
    metric: str = BLOAT_METRIC[Profile.AGENTIC]
    sample_counts: dict[tuple[Category, Complexity], int] = field(default_factory=dict)

    @classmethod
    def from_turns(
        cls,
        turns: Iterable[Turn],
        classifications: dict[str, Classification],
        min_samples: int = DEFAULT_MIN_SAMPLES,
    ) -> BloatBaseline:
        """Build a baseline from classified turns.

        Turns of mixed profile are not pooled — the metric differs between them,
        so a shared median would be meaningless. The dominant profile wins.
        """
        turns = [t for t in turns if t.turn_id in classifications]
        if not turns:
            return cls(min_samples=min_samples)

        profile = _dominant_profile(turns)
        metric = BLOAT_METRIC[profile]

        pairs: dict[tuple[Category, Complexity], list[int]] = {}
        complexities: dict[Complexity, list[int]] = {}

        for turn in turns:
            if turn.profile is not profile:
                continue
            found = classifications[turn.turn_id]
            value = turn.tokens(metric)
            pairs.setdefault((found.category, found.complexity), []).append(value)
            complexities.setdefault(found.complexity, []).append(value)

        return cls(
            min_samples=min_samples,
            metric=metric,
            by_pair={
                key: median(values)
                for key, values in pairs.items()
                if len(values) >= min_samples
            },
            by_complexity={
                key: median(values)
                for key, values in complexities.items()
                if len(values) >= min_samples
            },
            sample_counts={key: len(values) for key, values in pairs.items()},
        )

    def median_for(self, category: Category, complexity: Complexity) -> float | None:
        """Baseline for this kind of work, or None if the sample is too thin.

        Falls back from (category, complexity) to complexity alone, since
        difficulty is the axis that drives token usage and a coarser reference
        beats no reference.
        """
        pair = self.by_pair.get((category, complexity))
        if pair is not None:
            return pair
        return self.by_complexity.get(complexity)

    def samples_for(self, category: Category, complexity: Complexity) -> int:
        return self.sample_counts.get((category, complexity), 0)

    @property
    def is_empty(self) -> bool:
        return not self.by_pair and not self.by_complexity


def _dominant_profile(turns: list[Turn]) -> Profile:
    agentic = sum(1 for t in turns if t.profile is Profile.AGENTIC)
    return Profile.AGENTIC if agentic * 2 >= len(turns) else Profile.SIMPLE
