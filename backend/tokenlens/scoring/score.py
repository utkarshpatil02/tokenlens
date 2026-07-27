"""Waste Score.

The score is denominated in dollars. An earlier design used fixed weights over
bounded [0,1] components (45 overshoot / 35 bloat / 20 zero-value), which was
defensible in spirit but ultimately a chosen constant that invites "why 45 and
not 40" with no real answer. Pricing overshoot and bloat directly removes the
judgement call: the number comes from the same rate sheet the vendor bills
against.

Two failure modes in that earlier design are now invariants, each with a test:

* Using a **cheaper** model than the task required must never produce waste. The
  old form went negative there, implying a saving where there was a quality
  risk. It is now clamped at zero and surfaced as `under_provisioned` instead.
* A **bloated prompt on a correctly chosen model** must still register waste. The
  old multiplicative form multiplied bloat by an overshoot of zero, making half
  the waste it existed to measure invisible.

A third invariant is new: waste can never exceed what was actually spent.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum

from tokenlens.classify.schema import Classification
from tokenlens.models import Profile, Turn
from tokenlens.pricing import PriceTable, default_table
from tokenlens.scoring.baseline import BLOAT_METRIC, BloatBaseline

# Metric-to-rate mapping, so the excess is priced as the same kind of token it
# actually was.
_RATE_KEY = {"input_tokens": "input", "cache_read": "cache_read"}


class Band(str, Enum):
    EFFICIENT = "efficient"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"


def band_for(normalized: int) -> Band:
    if normalized <= 20:
        return Band.EFFICIENT
    if normalized <= 50:
        return Band.MODERATE
    if normalized <= 80:
        return Band.HIGH
    return Band.CRITICAL


@dataclass(frozen=True, slots=True)
class WasteScore:
    """One turn's waste, in dollars, with every component inspectable."""

    turn_id: str
    actual_cost: Decimal
    overshoot_cost: Decimal
    bloat_cost: Decimal
    tier_used: int
    tier_required: int
    zero_value: bool = False
    under_provisioned: bool = False
    bloat_measured: bool = True
    excess_tokens: int = 0
    bloat_metric: str = "cache_read"
    call_count: int = 1
    calls_baseline: float | None = None

    @property
    def estimated_waste(self) -> Decimal:
        """Dollars that need not have been spent.

        Busywork forfeits the whole cost: the task did not warrant a model at any
        tier, so switching to a cheaper one is not the remedy. Otherwise waste is
        overshoot plus bloat, capped at what was actually spent.
        """
        if self.zero_value:
            return self.actual_cost
        return min(self.overshoot_cost + self.bloat_cost, self.actual_cost)

    @property
    def normalized(self) -> int:
        """Waste as a percentage of this turn's cost, for ranking and bands."""
        if self.actual_cost <= 0:
            return 0
        pct = self.estimated_waste / self.actual_cost * 100
        return max(0, min(100, int(round(float(pct)))))

    @property
    def band(self) -> Band:
        return band_for(self.normalized)

    @property
    def turn_efficiency(self) -> float | None:
        """Calls made against calls typical for this difficulty.

        A diagnostic, not a priced component — the extra calls' cost is already
        inside `cache_read`, so charging for both would double-count. It explains
        *why* a turn is bloated.
        """
        if not self.calls_baseline:
            return None
        return self.call_count / self.calls_baseline

    @property
    def recommendation(self) -> str:
        if self.zero_value:
            return "Task did not warrant a model call"
        parts: list[str] = []
        if self.overshoot_cost > 0:
            parts.append(f"use a tier {self.tier_required} model")
        if self.bloat_cost > 0:
            parts.append(f"trim {self.excess_tokens:,} excess {self.bloat_metric} tokens")
        if self.under_provisioned:
            parts.append("check output quality: model was below the required tier")
        return "; ".join(parts) if parts else "No waste detected"


class Scorer:
    """Scores turns against a baseline and a rate table."""

    def __init__(
        self,
        baseline: BloatBaseline | None = None,
        table: PriceTable | None = None,
        calls_baseline: dict | None = None,
    ):
        self.baseline = baseline if baseline is not None else BloatBaseline()
        self.table = table or default_table()
        self.calls_baseline = calls_baseline or {}

    def score(self, turn: Turn, found: Classification) -> WasteScore:
        required = found.required_tier

        actual = Decimal(0)
        overshoot = Decimal(0)
        tiers: list[int] = []
        under = False

        for call in turn.calls:
            cost = self.table.cost_of(call)
            actual += cost
            tier = self.table.tier_of(call.model)
            tiers.append(tier)
            if tier > required:
                # Clamped by construction: only a more expensive tier than
                # required can contribute.
                overshoot += cost - self.table.cost_at_tier(call, required)
            elif tier < required:
                under = True

        bloat, excess, measured = self._bloat(turn, found, required)

        return WasteScore(
            turn_id=turn.turn_id,
            actual_cost=actual,
            overshoot_cost=overshoot,
            bloat_cost=bloat,
            tier_used=max(tiers) if tiers else required,
            tier_required=required,
            zero_value=found.is_zero_value,
            under_provisioned=under,
            bloat_measured=measured,
            excess_tokens=excess,
            bloat_metric=BLOAT_METRIC.get(turn.profile, "cache_read"),
            call_count=turn.call_count,
            calls_baseline=self.calls_baseline.get(found.complexity),
        )

    def score_all(
        self, turns: Iterable[Turn], classifications: dict[str, Classification]
    ) -> list[WasteScore]:
        return [
            self.score(turn, classifications[turn.turn_id])
            for turn in turns
            if turn.turn_id in classifications
        ]

    def _bloat(
        self, turn: Turn, found: Classification, required: int
    ) -> tuple[Decimal, int, bool]:
        """Cost of tokens beyond what comparable work needed.

        Priced at the **required** tier, not the tier actually used, so that
        overshoot and bloat stay disjoint. Overshoot already charges the
        model-choice delta across every token, including the excess ones; pricing
        the excess again at the expensive model's rate would bill the same tokens
        twice and can push reported waste above what was actually spent.

        With this split the two components sum to exactly
        `actual_cost - ideal_cost`, where ideal means the required tier at the
        median volume: overshoot is the model delta at the observed volume, bloat
        is the volume delta at the correct model.
        """
        reference = self.baseline.median_for(found.category, found.complexity)
        if reference is None:
            return Decimal(0), 0, False

        metric = BLOAT_METRIC.get(turn.profile, "cache_read")
        actual_tokens = turn.tokens(metric)
        excess = int(max(0, actual_tokens - reference))
        if excess == 0 or actual_tokens == 0:
            return Decimal(0), 0, True

        rates = self.table.rates_for(
            self.table.reference_model(required),
            at=turn.timestamp,
        )
        rate = getattr(rates, _RATE_KEY[metric])
        return (Decimal(excess) * rate) / Decimal(1_000_000), excess, True


def calls_baseline_from(
    turns: Iterable[Turn],
    classifications: dict[str, Classification],
    min_samples: int = 5,
) -> dict:
    """Median calls per turn, per complexity.

    Only meaningful for agentic data, where one prompt drives many calls.
    """
    from statistics import median

    buckets: dict = {}
    for turn in turns:
        found = classifications.get(turn.turn_id)
        if found is None or turn.profile is not Profile.AGENTIC:
            continue
        buckets.setdefault(found.complexity, []).append(turn.call_count)
    return {
        complexity: median(counts)
        for complexity, counts in buckets.items()
        if len(counts) >= min_samples
    }
