"""Waste Score tests.

`TestV1FailureModes` is the important class: it pins the two defects that made
the original multiplicative formula unable to measure what it existed to measure.
Both are cheap to reintroduce during a refactor and silent when reintroduced.
"""

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from tokenlens.classify.schema import Category, Classification, Complexity
from tokenlens.models import Call, Profile, Turn
from tokenlens.pricing import default_table
from tokenlens.scoring import (
    Band,
    BloatBaseline,
    Scorer,
    band_for,
    calls_baseline_from,
)

WHEN = datetime(2026, 7, 20, tzinfo=timezone.utc)

HAIKU = "claude-haiku-4-5"  # tier 1
SONNET = "claude-sonnet-5"  # tier 2
OPUS = "claude-opus-5"  # tier 3


def call(model=OPUS, cache_read=0, output_tokens=1_000, **kw) -> Call:
    return Call(
        model=model, timestamp=WHEN, cache_read=cache_read, output_tokens=output_tokens, **kw
    )


def turn(
    turn_id="t1", calls=None, profile=Profile.AGENTIC, prompt="do a thing", **kw
) -> Turn:
    return Turn(
        turn_id=turn_id,
        profile=profile,
        timestamp=WHEN,
        calls=calls if calls is not None else [call()],
        prompt_text=prompt,
        **kw,
    )


def classification(
    category=Category.CODING, complexity=Complexity.TRIVIAL, confidence=0.9
) -> Classification:
    return Classification(
        category=category,
        complexity=complexity,
        confidence=confidence,
        rationale="r",
        model=HAIKU,
    )


def baseline_with(median_tokens, category=Category.CODING, complexity=Complexity.TRIVIAL):
    """A baseline asserting one known median, bypassing sample-count gating."""
    return BloatBaseline(
        min_samples=1,
        by_pair={(category, complexity): median_tokens},
        by_complexity={complexity: median_tokens},
        metric="cache_read",
    )


class TestV1FailureModes:
    """The two defects that motivated rebuilding the formula."""

    def test_cheaper_model_than_required_is_never_waste(self):
        """v1 went negative here, implying a saving where there is a quality risk."""
        score = Scorer().score(
            turn(calls=[call(model=HAIKU)]),
            classification(complexity=Complexity.COMPLEX),  # needs tier 3
        )
        assert score.overshoot_cost == 0
        assert score.estimated_waste == 0
        assert score.normalized == 0

    def test_under_provisioning_is_surfaced_not_scored(self):
        score = Scorer().score(
            turn(calls=[call(model=HAIKU)]),
            classification(complexity=Complexity.COMPLEX),
        )
        assert score.under_provisioned
        assert "quality" in score.recommendation

    def test_bloat_registers_even_when_the_model_is_correct(self):
        """v1 multiplied bloat by an overshoot of zero, hiding half the waste."""
        score = Scorer(baseline=baseline_with(1_000)).score(
            turn(calls=[call(model=HAIKU, cache_read=500_000)]),
            classification(complexity=Complexity.TRIVIAL),  # tier 1 == tier used
        )
        assert score.overshoot_cost == 0  # model choice was right
        assert score.bloat_cost > 0  # and yet there is waste
        assert score.estimated_waste > 0

    def test_no_component_can_be_negative(self):
        score = Scorer(baseline=baseline_with(10_000_000)).score(
            turn(calls=[call(model=HAIKU, cache_read=1_000)]),
            classification(complexity=Complexity.COMPLEX),
        )
        assert score.overshoot_cost >= 0
        assert score.bloat_cost >= 0
        assert score.estimated_waste >= 0


class TestOvershoot:
    def test_frontier_model_on_a_trivial_task_is_waste(self):
        score = Scorer().score(turn(calls=[call(model=OPUS)]), classification())
        assert score.overshoot_cost > 0
        assert score.tier_used == 3
        assert score.tier_required == 1

    def test_matching_tier_produces_no_overshoot(self):
        score = Scorer().score(
            turn(calls=[call(model=SONNET)]), classification(complexity=Complexity.MODERATE)
        )
        assert score.overshoot_cost == 0

    def test_overshoot_is_the_gap_to_the_reference_model(self):
        table = default_table()
        c = call(model=OPUS, cache_read=100_000)
        score = Scorer(table=table).score(turn(calls=[c]), classification())
        expected = table.cost_of(c) - table.cost_at_tier(c, 1)
        assert score.overshoot_cost == expected

    def test_bigger_tier_gap_costs_more(self):
        scorer = Scorer()
        from_tier_2 = scorer.score(
            turn(calls=[call(model=SONNET)]), classification(complexity=Complexity.TRIVIAL)
        )
        from_tier_3 = scorer.score(
            turn(calls=[call(model=OPUS)]), classification(complexity=Complexity.TRIVIAL)
        )
        assert from_tier_3.overshoot_cost > from_tier_2.overshoot_cost

    def test_overshoot_accrues_per_call_across_mixed_models(self):
        """A turn may span models; each call is judged on its own tier."""
        score = Scorer().score(
            turn(calls=[call(model=OPUS), call(model=HAIKU)]), classification()
        )
        only_opus = Scorer().score(turn(calls=[call(model=OPUS)]), classification())
        assert score.overshoot_cost == only_opus.overshoot_cost

    def test_output_tokens_are_included_in_the_counterfactual(self):
        """Output is a large share of cost and is priced differently per model."""
        table = default_table()
        c = call(model=OPUS, output_tokens=100_000, cache_read=0)
        assert table.cost_at_tier(c, 1) < table.cost_of(c)


class TestBloat:
    def test_excess_over_the_median_is_priced(self):
        score = Scorer(baseline=baseline_with(10_000)).score(
            turn(calls=[call(model=HAIKU, cache_read=60_000)]), classification()
        )
        assert score.excess_tokens == 50_000
        assert score.bloat_cost > 0

    def test_usage_at_the_median_is_not_bloat(self):
        score = Scorer(baseline=baseline_with(10_000)).score(
            turn(calls=[call(model=HAIKU, cache_read=10_000)]), classification()
        )
        assert score.bloat_cost == 0
        assert score.excess_tokens == 0

    def test_below_median_usage_is_not_bloat(self):
        score = Scorer(baseline=baseline_with(10_000)).score(
            turn(calls=[call(model=HAIKU, cache_read=500)]), classification()
        )
        assert score.bloat_cost == 0

    def test_thin_sample_yields_no_bloat_claim(self):
        """A median over too few turns is noise; report nothing instead."""
        score = Scorer(baseline=BloatBaseline()).score(
            turn(calls=[call(cache_read=999_999)]), classification()
        )
        assert not score.bloat_measured
        assert score.bloat_cost == 0

    def test_excess_is_priced_at_the_required_tier_not_the_tier_used(self):
        """Otherwise overshoot and bloat bill the same excess tokens twice.

        Both turns need tier 1, so the excess costs the same in each; the fact
        that one ran on Opus is charged by overshoot, not again by bloat.
        """
        scorer = Scorer(baseline=baseline_with(1_000))
        on_opus = scorer.score(turn(calls=[call(model=OPUS, cache_read=100_000)]), classification())
        on_haiku = scorer.score(
            turn(calls=[call(model=HAIKU, cache_read=100_000)]), classification()
        )
        assert on_opus.bloat_cost == on_haiku.bloat_cost

    def test_higher_required_tier_prices_the_same_excess_higher(self):
        scorer = Scorer(
            baseline=BloatBaseline(
                min_samples=1,
                by_complexity={Complexity.TRIVIAL: 1_000.0, Complexity.COMPLEX: 1_000.0},
                metric="cache_read",
            )
        )
        cheap_tier = scorer.score(
            turn(calls=[call(model=OPUS, cache_read=100_000)]),
            classification(complexity=Complexity.TRIVIAL),
        )
        frontier_tier = scorer.score(
            turn(calls=[call(model=OPUS, cache_read=100_000)]),
            classification(complexity=Complexity.COMPLEX),
        )
        assert frontier_tier.bloat_cost > cheap_tier.bloat_cost

    def test_agentic_bloat_uses_cache_read_not_input(self):
        """On agentic data input_tokens is ~0% of spend; using it measures nothing."""
        score = Scorer(baseline=baseline_with(1_000)).score(
            turn(calls=[call(model=HAIKU, input_tokens=2, cache_read=400_000)]),
            classification(),
        )
        assert score.bloat_metric == "cache_read"
        assert score.bloat_cost > 0

    def test_simple_profile_bloat_uses_input_tokens(self):
        baseline = BloatBaseline(
            min_samples=1,
            by_pair={(Category.CODING, Complexity.TRIVIAL): 400.0},
            metric="input_tokens",
        )
        score = Scorer(baseline=baseline).score(
            turn(
                profile=Profile.SIMPLE,
                calls=[call(model=OPUS, input_tokens=3_200, cache_read=0)],
            ),
            classification(),
        )
        assert score.bloat_metric == "input_tokens"
        assert score.excess_tokens == 2_800


class TestZeroValue:
    def test_busywork_forfeits_the_whole_cost(self):
        """No cheaper tier is the remedy — the call should not have happened."""
        score = Scorer().score(
            turn(calls=[call(model=HAIKU)]),
            classification(category=Category.BUSYWORK),
        )
        assert score.zero_value
        assert score.estimated_waste == score.actual_cost
        assert score.normalized == 100

    def test_busywork_on_a_frontier_model_is_still_capped_at_cost(self):
        score = Scorer(baseline=baseline_with(100)).score(
            turn(calls=[call(model=OPUS, cache_read=500_000)]),
            classification(category=Category.BUSYWORK),
        )
        assert score.estimated_waste == score.actual_cost

    def test_non_busywork_is_not_flagged(self):
        score = Scorer().score(turn(), classification(category=Category.CODING))
        assert not score.zero_value


class TestComponentAdditivity:
    """Overshoot and bloat must be disjoint, or waste is overstated.

    Together they should equal `actual - ideal`, where ideal is the required
    tier at the median volume. Pricing the excess at the tier actually used
    instead double-bills it and can exceed the amount spent.
    """

    def test_components_sum_to_actual_minus_ideal(self):
        table = default_table()
        median_tokens = 400
        c = call(model=OPUS, input_tokens=3_200, output_tokens=800, cache_read=0)
        t = turn(profile=Profile.SIMPLE, calls=[c])
        baseline = BloatBaseline(
            min_samples=1,
            by_pair={(Category.CODING, Complexity.TRIVIAL): float(median_tokens)},
            metric="input_tokens",
        )
        score = Scorer(baseline=baseline, table=table).score(t, classification())

        ideal = table.cost_of(
            Call(
                model=table.reference_model(1),
                timestamp=WHEN,
                input_tokens=median_tokens,
                output_tokens=800,
            )
        )
        assert score.overshoot_cost + score.bloat_cost == score.actual_cost - ideal

    def test_prd_worked_example_matches_its_published_figures(self):
        """3,200-token prompt to Opus for a trivial reformat; median is 400."""
        baseline = BloatBaseline(
            min_samples=1,
            by_pair={(Category.CODING, Complexity.TRIVIAL): 400.0},
            metric="input_tokens",
        )
        score = Scorer(baseline=baseline).score(
            turn(
                profile=Profile.SIMPLE,
                calls=[call(model=OPUS, input_tokens=3_200, output_tokens=800, cache_read=0)],
            ),
            classification(),
        )
        assert score.excess_tokens == 2_800
        assert score.tier_used == 3
        assert score.tier_required == 1
        assert score.normalized == 88
        assert score.band is Band.CRITICAL

    def test_overshoot_alone_cannot_exceed_cost(self):
        score = Scorer().score(turn(calls=[call(model=OPUS, cache_read=900_000)]), classification())
        assert score.overshoot_cost < score.actual_cost


class TestInvariants:
    def test_waste_never_exceeds_spend(self):
        score = Scorer(baseline=baseline_with(1)).score(
            turn(calls=[call(model=OPUS, cache_read=5_000_000)]), classification()
        )
        assert score.estimated_waste <= score.actual_cost

    def test_normalized_is_bounded(self):
        score = Scorer(baseline=baseline_with(1)).score(
            turn(calls=[call(model=OPUS, cache_read=5_000_000)]), classification()
        )
        assert 0 <= score.normalized <= 100

    def test_zero_cost_turn_does_not_divide_by_zero(self):
        score = Scorer().score(
            turn(calls=[call(model=HAIKU, output_tokens=0)]), classification()
        )
        assert score.normalized == 0

    def test_turn_with_no_calls_is_harmless(self):
        score = Scorer().score(turn(calls=[]), classification())
        assert score.actual_cost == 0
        assert score.estimated_waste == 0

    def test_components_are_decimal_not_float(self):
        score = Scorer(baseline=baseline_with(10)).score(
            turn(calls=[call(cache_read=1_000)]), classification()
        )
        assert isinstance(score.overshoot_cost, Decimal)
        assert isinstance(score.bloat_cost, Decimal)
        assert isinstance(score.estimated_waste, Decimal)


class TestBands:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (0, Band.EFFICIENT),
            (20, Band.EFFICIENT),
            (21, Band.MODERATE),
            (50, Band.MODERATE),
            (51, Band.HIGH),
            (80, Band.HIGH),
            (81, Band.CRITICAL),
            (100, Band.CRITICAL),
        ],
    )
    def test_band_boundaries(self, value, expected):
        assert band_for(value) is expected

    def test_clean_turn_lands_in_efficient(self):
        score = Scorer().score(
            turn(calls=[call(model=SONNET)]), classification(complexity=Complexity.MODERATE)
        )
        assert score.band is Band.EFFICIENT


class TestRecommendation:
    def test_overshoot_recommends_the_required_tier(self):
        score = Scorer().score(turn(calls=[call(model=OPUS)]), classification())
        assert "tier 1" in score.recommendation

    def test_bloat_recommends_trimming(self):
        score = Scorer(baseline=baseline_with(1_000)).score(
            turn(calls=[call(model=HAIKU, cache_read=90_000)]), classification()
        )
        assert "trim" in score.recommendation

    def test_busywork_recommends_not_calling_at_all(self):
        score = Scorer().score(turn(), classification(category=Category.BUSYWORK))
        assert "did not warrant" in score.recommendation

    def test_clean_turn_says_so(self):
        score = Scorer().score(
            turn(calls=[call(model=SONNET)]), classification(complexity=Complexity.MODERATE)
        )
        assert score.recommendation == "No waste detected"


class TestBaselineConstruction:
    def _corpus(self, n=6):
        turns = [
            turn(turn_id=f"t{i}", calls=[call(model=HAIKU, cache_read=1_000 * (i + 1))])
            for i in range(n)
        ]
        found = {t.turn_id: classification() for t in turns}
        return turns, found

    def test_median_is_computed_from_the_corpus(self):
        turns, found = self._corpus()
        baseline = BloatBaseline.from_turns(turns, found, min_samples=3)
        assert baseline.median_for(Category.CODING, Complexity.TRIVIAL) == 3_500

    def test_thin_cell_is_withheld(self):
        turns, found = self._corpus(n=2)
        baseline = BloatBaseline.from_turns(turns, found, min_samples=5)
        assert baseline.median_for(Category.CODING, Complexity.TRIVIAL) is None

    def test_falls_back_from_pair_to_complexity(self):
        """A coarser reference beats no reference."""
        turns, found = self._corpus(n=6)
        baseline = BloatBaseline.from_turns(turns, found, min_samples=3)
        assert baseline.median_for(Category.WRITING, Complexity.TRIVIAL) == 3_500

    def test_unclassified_turns_are_excluded(self):
        turns, _ = self._corpus()
        assert BloatBaseline.from_turns(turns, {}).is_empty

    def test_agentic_corpus_selects_the_cache_read_metric(self):
        turns, found = self._corpus()
        assert BloatBaseline.from_turns(turns, found, min_samples=3).metric == "cache_read"

    def test_empty_corpus_is_empty_not_an_error(self):
        assert BloatBaseline.from_turns([], {}).is_empty


class TestCallsBaseline:
    def test_median_calls_per_complexity(self):
        turns = [
            turn(turn_id=f"t{i}", calls=[call() for _ in range(i + 1)]) for i in range(5)
        ]
        found = {t.turn_id: classification() for t in turns}
        assert calls_baseline_from(turns, found, min_samples=3)[Complexity.TRIVIAL] == 3

    def test_efficiency_ratio_is_reported(self):
        scorer = Scorer(calls_baseline={Complexity.TRIVIAL: 4.0})
        score = scorer.score(turn(calls=[call() for _ in range(20)]), classification())
        assert score.turn_efficiency == 5.0

    def test_efficiency_is_none_without_a_baseline(self):
        assert Scorer().score(turn(), classification()).turn_efficiency is None

    def test_efficiency_is_not_priced(self):
        """Extra calls' cost already sits in cache_read; charging twice is wrong."""
        scorer = Scorer(calls_baseline={Complexity.TRIVIAL: 1.0})
        calls = [call(model=HAIKU) for _ in range(10)]
        score = scorer.score(turn(calls=calls), classification())
        assert score.estimated_waste == 0
        assert score.turn_efficiency == 10.0


class TestScoreAll:
    def test_scores_only_classified_turns(self):
        turns = [turn("t1"), turn("t2")]
        scores = Scorer().score_all(turns, {"t1": classification()})
        assert [s.turn_id for s in scores] == ["t1"]

    def test_empty_input_yields_no_scores(self):
        assert Scorer().score_all([], {}) == []
