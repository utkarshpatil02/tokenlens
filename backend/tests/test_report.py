"""Report aggregation tests.

The aggregate must reconcile with the per-call figures it is built from — a
report that quietly disagrees with the cost engine would undermine every number
the project publishes.
"""

from decimal import Decimal
from pathlib import Path

import pytest

from tokenlens.ingest import parse_projects, parse_session
from tokenlens.pricing import default_table
from tokenlens.report import build_report, format_report, main

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def report():
    return build_report(parse_projects(FIXTURES))


class TestReconciliation:
    def test_total_equals_sum_of_priced_calls(self, report):
        table = default_table()
        expected = sum(
            (table.cost_of(c) for t in parse_projects(FIXTURES) for c in t.calls),
            Decimal(0),
        )
        assert report["total"] == expected

    def test_category_breakdown_sums_to_total(self, report):
        assert sum(report["by_category"].values()) == report["total"]

    def test_model_breakdown_sums_to_total(self, report):
        assert sum(report["by_model"].values()) == report["total"]

    def test_call_count_matches_ingestion(self, report):
        turns = parse_projects(FIXTURES)
        assert report["calls"] == sum(t.call_count for t in turns)

    def test_calls_per_turn_histogram_totals_the_turns(self, report):
        assert sum(report["calls_per_turn"].values()) == report["turns"]

    def test_ranked_turns_covers_every_turn(self, report):
        assert len(report["ranked_turns"]) == report["turns"]

    def test_ranked_turns_is_ordered_by_cost(self, report):
        costs = [cost for cost, _ in report["ranked_turns"]]
        assert costs == sorted(costs, reverse=True)


class TestContent:
    def test_scorable_count_never_exceeds_turn_count(self, report):
        assert report["scorable_turns"] <= report["turns"]

    def test_token_totals_are_tracked_per_category(self, report):
        assert report["tokens"]["cache_read"] > 0

    def test_cache_outweighs_uncached_input(self, report):
        """The finding that shaped the cost engine, asserted end to end."""
        cache = (
            report["by_category"]["cache_read"]
            + report["by_category"]["cache_write_1h"]
            + report["by_category"]["cache_write_5m"]
        )
        assert cache > report["by_category"]["input_tokens"]


class TestFormatting:
    def test_renders_headline_figures(self, report):
        text = format_report(report)
        assert "total spend" in text
        assert "Where the money went" in text
        assert "Most expensive turns" in text

    def test_rate_table_provenance_is_shown(self, report):
        """A published figure must name the table that produced it."""
        text = format_report(report)
        assert "rate table v" in text
        assert "updated" in text

    def test_unattributed_turns_are_labelled_not_blank(self, report):
        text = format_report(report, top=50)
        assert "(unattributed" in text

    def test_top_limits_the_turn_list(self, report):
        assert format_report(report, top=1).count("calls  ") == 1

    def test_long_prompts_are_truncated(self, report):
        assert all(len(line) < 120 for line in format_report(report).splitlines())

    def test_empty_input_does_not_divide_by_zero(self):
        text = format_report(build_report([]))
        assert "No billable calls found." in text


class TestCli:
    def test_runs_against_a_directory(self, capsys):
        assert main([str(FIXTURES)]) == 0
        assert "total spend" in capsys.readouterr().out

    def test_top_flag_is_honoured(self, capsys):
        main([str(FIXTURES), "--top", "2"])
        assert capsys.readouterr().out.count("calls  ") == 2

    def test_missing_directory_exits_with_error(self, tmp_path):
        with pytest.raises(SystemExit) as exc:
            main([str(tmp_path / "nope")])
        assert exc.value.code != 0

    def test_single_session_file_is_a_valid_target(self, capsys):
        """A file works because rglob on a file yields nothing — report is empty
        but must not crash."""
        main([str(FIXTURES / "sample_session.jsonl")])
        assert "TokenLens" in capsys.readouterr().out


class TestSingleSessionParity:
    def test_one_file_report_reconciles_too(self):
        turns = parse_session(FIXTURES / "sample_session.jsonl")
        report = build_report(turns)
        assert sum(report["by_category"].values()) == report["total"]
        assert report["calls"] == 7
