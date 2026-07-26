"""Cost engine tests.

The cache-aware cases are the ones that matter: the engine exists because
pricing only `input_tokens` and `output_tokens` misses ~99% of real agentic
spend, and because the 1-hour cache TTL costs 2x base against the 5-minute
tier's 1.25x.
"""

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from tokenlens.models import Call
from tokenlens.pricing import PriceTable, UnknownModelError, default_table

# Inside the Sonnet 5 introductory window (through 2026-08-31).
DURING_PROMO = datetime(2026, 7, 26, tzinfo=timezone.utc)
# After it.
AFTER_PROMO = datetime(2026, 9, 1, tzinfo=timezone.utc)


@pytest.fixture
def table() -> PriceTable:
    return default_table()


def call(model="claude-opus-5", when=AFTER_PROMO, **tokens) -> Call:
    return Call(model=model, timestamp=when, **tokens)


class TestCacheWriteTTL:
    """The 1h vs 5m split is the detail most cost estimators get wrong."""

    def test_1h_write_costs_more_than_5m_for_same_tokens(self, table):
        tokens = 100_000
        five_min = table.cost_of(call(cache_write_5m=tokens))
        one_hour = table.cost_of(call(cache_write_1h=tokens))
        assert one_hour > five_min

    def test_write_multipliers_are_1_25x_and_2x_base_input(self, table):
        tokens = 1_000_000
        base = table.cost_of(call(input_tokens=tokens))
        assert table.cost_of(call(cache_write_5m=tokens)) == base * Decimal("1.25")
        assert table.cost_of(call(cache_write_1h=tokens)) == base * Decimal("2")

    def test_cache_read_is_a_tenth_of_base_input(self, table):
        tokens = 1_000_000
        base = table.cost_of(call(input_tokens=tokens))
        assert table.cost_of(call(cache_read=tokens)) == base * Decimal("0.1")

    def test_ttl_tiers_are_summed_not_double_counted(self, table):
        both = table.cost_of(call(cache_write_5m=40_000, cache_write_1h=60_000))
        separate = table.cost_of(call(cache_write_5m=40_000)) + table.cost_of(
            call(cache_write_1h=60_000)
        )
        assert both == separate


class TestCacheAwareness:
    """Regression guard for the bug this engine was designed to avoid."""

    def test_cache_only_call_is_not_free(self, table):
        """A call with no fresh input still costs money.

        This is the shape of a real agentic call: input_tokens near zero, cost
        carried entirely by cache traffic and output.
        """
        c = call(input_tokens=2, output_tokens=286, cache_read=34_488, cache_write_1h=12_359)
        assert table.cost_of(c) > Decimal("0.10")

    def test_uncached_input_is_a_negligible_share_of_agentic_cost(self, table):
        """Documents *why* pricing input alone is not viable."""
        c = call(input_tokens=2, output_tokens=286, cache_read=34_488, cache_write_1h=12_359)
        breakdown = table.cost_breakdown(c)
        input_share = breakdown["input_tokens"] / table.cost_of(c)
        assert input_share < Decimal("0.001")

    def test_breakdown_sums_to_total(self, table):
        c = call(input_tokens=500, output_tokens=1_200, cache_read=80_000, cache_write_1h=9_000)
        assert sum(table.cost_breakdown(c).values()) == table.cost_of(c)

    def test_breakdown_covers_every_priced_category(self, table):
        breakdown = table.cost_breakdown(call(input_tokens=10))
        assert set(breakdown) == {
            "input_tokens",
            "output_tokens",
            "cache_read",
            "cache_write_5m",
            "cache_write_1h",
        }


class TestPromotionalPricing:
    """Sonnet 5 introductory rates run through 2026-08-31."""

    def test_promo_applies_inside_window(self, table):
        rates = table.rates_for("claude-sonnet-5", at=DURING_PROMO)
        assert rates.promotional
        assert rates.input == Decimal("2.00")

    def test_list_rates_apply_after_window(self, table):
        rates = table.rates_for("claude-sonnet-5", at=AFTER_PROMO)
        assert not rates.promotional
        assert rates.input == Decimal("3.00")

    def test_last_day_of_window_is_inclusive(self, table):
        rates = table.rates_for(
            "claude-sonnet-5", at=datetime(2026, 8, 31, 23, 59, tzinfo=timezone.utc)
        )
        assert rates.promotional

    def test_first_day_after_window_is_list_priced(self, table):
        rates = table.rates_for("claude-sonnet-5", at=datetime(2026, 9, 1, tzinfo=timezone.utc))
        assert not rates.promotional

    def test_unknown_date_does_not_assume_a_discount(self, table):
        """Never silently apply a time-limited rate we cannot justify."""
        assert not table.rates_for("claude-sonnet-5", at=None).promotional

    def test_promo_lowers_actual_call_cost(self, table):
        tokens = {"input_tokens": 1_000_000}
        during = table.cost_of(call(model="claude-sonnet-5", when=DURING_PROMO, **tokens))
        after = table.cost_of(call(model="claude-sonnet-5", when=AFTER_PROMO, **tokens))
        assert during < after

    def test_model_without_promo_is_date_insensitive(self, table):
        tokens = {"input_tokens": 1_000_000}
        during = table.cost_of(call(model="claude-opus-5", when=DURING_PROMO, **tokens))
        after = table.cost_of(call(model="claude-opus-5", when=AFTER_PROMO, **tokens))
        assert during == after


class TestModelResolution:
    def test_known_model_resolves_to_itself(self, table):
        assert table.resolve("claude-opus-5") == "claude-opus-5"

    def test_unlisted_point_version_falls_back_by_prefix(self, table):
        """A model released after the table was written should still price."""
        assert table.resolve("claude-opus-9-9") == "claude-opus-5"

    def test_longest_prefix_wins(self, table):
        assert table.resolve("gpt-4o-mini-2099") == "gpt-4o-mini"
        assert table.resolve("gpt-4o-2099") == "gpt-4o"

    def test_unknown_model_raises_rather_than_pricing_at_zero(self, table):
        with pytest.raises(UnknownModelError, match="mystery-model"):
            table.cost_of(call(model="mystery-model", input_tokens=1_000))

    def test_tiers_are_ordered_cheap_to_frontier(self, table):
        assert table.tier_of("claude-haiku-4-5") == 1
        assert table.tier_of("claude-sonnet-5") == 2
        assert table.tier_of("claude-opus-5") == 3

    def test_tier_is_not_affected_by_promotional_rates(self, table):
        assert table.rates_for("claude-sonnet-5", at=DURING_PROMO).tier == 2


class TestEdgeCases:
    def test_zero_token_call_costs_nothing(self, table):
        assert table.cost_of(call()) == Decimal(0)

    def test_cost_is_exact_decimal_not_float(self, table):
        cost = table.cost_of(call(model="claude-haiku-4-5", input_tokens=3))
        assert isinstance(cost, Decimal)
        assert cost == Decimal("0.000003")

    def test_frontier_model_costs_more_than_cheap_one(self, table):
        tokens = {"input_tokens": 1_000_000, "output_tokens": 1_000_000}
        assert table.cost_of(call(model="claude-opus-5", **tokens)) > table.cost_of(
            call(model="claude-haiku-4-5", **tokens)
        )

    def test_cost_scales_linearly_with_tokens(self, table):
        one = table.cost_of(call(output_tokens=1_000))
        ten = table.cost_of(call(output_tokens=10_000))
        assert ten == one * 10


class TestTableMetadata:
    def test_table_is_dated_and_versioned(self, table):
        """Any published figure must be traceable to the table that produced it."""
        assert table.version >= 1
        assert table.updated.year >= 2026
        assert table.currency == "USD"


class TestCallModel:
    def test_cache_write_sums_both_ttls(self):
        assert Call("m", AFTER_PROMO, cache_write_5m=10, cache_write_1h=32).cache_write == 42

    def test_billable_input_excludes_output(self):
        c = call(input_tokens=5, output_tokens=999, cache_read=10, cache_write_1h=20)
        assert c.billable_input_tokens == 35

    def test_total_tokens_covers_every_category(self):
        c = call(input_tokens=1, output_tokens=2, cache_read=4, cache_write_5m=8, cache_write_1h=16)
        assert c.total_tokens == 31
