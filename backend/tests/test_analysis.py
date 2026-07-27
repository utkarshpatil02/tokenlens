"""Analysis payload and API tests.

The payload is a contract the frontend codes against, so its shape and its
internal consistency are both asserted. Money must survive as exact strings, and
the waste section must be absent rather than zeroed when nothing is classified —
zeros would read as "no waste found" when the truth is "not measured".
"""

from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tokenlens.analysis import Analysis, build_analysis
from tokenlens.classify import ClassificationCache, Classifier, PROMPT_VERSION, cache_key
from tokenlens.classify.schema import Category, Classification, Complexity
from tokenlens.ingest import parse_projects
from tokenlens.pricing import default_table
from tokenlens.scoring import BloatBaseline, Scorer

FIXTURES = Path(__file__).parent / "fixtures"


def classification(
    category=Category.CODING, complexity=Complexity.TRIVIAL, confidence=0.9, escalated=False
) -> Classification:
    return Classification(
        category=category,
        complexity=complexity,
        confidence=confidence,
        rationale="because it is one step",
        model="claude-haiku-4-5",
        escalated=escalated,
        base_complexity=Complexity.MODERATE if escalated else None,
        base_category=category if escalated else None,
        base_confidence=0.3 if escalated else None,
    )


@pytest.fixture
def spend_only() -> dict:
    """Analysis with no classifications — the default state."""
    return build_analysis(FIXTURES).to_payload()


@pytest.fixture
def scored() -> dict:
    """Analysis with every scorable turn classified."""
    turns = parse_projects(FIXTURES)
    found = {t.turn_id: classification() for t in turns if t.is_scorable}
    baseline = BloatBaseline(
        min_samples=1,
        by_complexity={Complexity.TRIVIAL: 5_000.0},
        metric="cache_read",
    )
    table = default_table()
    scores = Scorer(baseline=baseline, table=table).score_all(turns, found)
    return Analysis(turns, found, scores, table, baseline).to_payload()


class TestSpendSection:
    def test_spend_analysis_needs_no_classification(self, spend_only):
        assert spend_only["overview"]["classified_turns"] == 0
        assert Decimal(spend_only["overview"]["total_cost"]) > 0

    def test_overview_counts_match_ingestion(self, spend_only):
        turns = parse_projects(FIXTURES)
        assert spend_only["overview"]["turns"] == len(turns)
        assert spend_only["overview"]["calls"] == sum(t.call_count for t in turns)

    def test_token_categories_sum_to_total(self, spend_only):
        total = Decimal(spend_only["overview"]["total_cost"])
        parts = sum(Decimal(r["cost"]) for r in spend_only["cost_by_token_category"])
        assert parts == total

    def test_models_sum_to_total(self, spend_only):
        total = Decimal(spend_only["overview"]["total_cost"])
        parts = sum(Decimal(r["cost"]) for r in spend_only["cost_by_model"])
        assert parts == total

    def test_shares_sum_to_one(self, spend_only):
        shares = sum(r["share"] for r in spend_only["cost_by_token_category"])
        assert shares == pytest.approx(1.0, abs=0.001)

    def test_models_carry_their_tier(self, spend_only):
        assert all(1 <= r["tier"] <= 3 for r in spend_only["cost_by_model"])

    def test_calls_per_turn_totals_the_turns(self, spend_only):
        assert sum(r["turns"] for r in spend_only["calls_per_turn"]) == (
            spend_only["overview"]["turns"]
        )

    def test_empty_categories_are_omitted(self, spend_only):
        """A zero row is noise on a chart."""
        assert all(
            r["tokens"] or Decimal(r["cost"]) for r in spend_only["cost_by_token_category"]
        )


class TestWasteSectionAbsence:
    def test_waste_is_null_when_nothing_is_classified(self, spend_only):
        """Not zeroed: zeros would read as 'no waste found'."""
        assert spend_only["waste"] is None

    def test_spend_section_still_populated_without_waste(self, spend_only):
        assert spend_only["cost_by_model"]
        assert spend_only["cost_by_token_category"]


class TestWasteSection:
    def test_present_once_classified(self, scored):
        assert scored["waste"] is not None

    def test_components_sum_to_total_waste(self, scored):
        """Overshoot and bloat are disjoint, so they must reconcile."""
        waste = scored["waste"]
        components = Decimal(waste["components"]["overshoot"]) + Decimal(
            waste["components"]["bloat"]
        )
        # Busywork forfeits full cost, so equality holds only without it.
        assert waste["flags"]["zero_value"] == 0
        assert components == Decimal(waste["total_waste"])

    def test_waste_never_exceeds_scored_cost(self, scored):
        waste = scored["waste"]
        assert Decimal(waste["total_waste"]) <= Decimal(waste["scored_cost"])

    def test_bands_cover_every_scored_turn(self, scored):
        waste = scored["waste"]
        assert sum(b["turns"] for b in waste["bands"]) == waste["scored_turns"]

    def test_all_four_bands_are_present_even_when_empty(self, scored):
        """A chart axis should not shift because a band happened to be empty."""
        bands = [b["band"] for b in scored["waste"]["bands"]]
        assert bands == ["efficient", "moderate", "high", "critical"]

    def test_heatmap_cells_carry_both_axes(self, scored):
        for cell in scored["waste"]["complexity_by_tier"]:
            assert cell["required_tier"] >= 1
            assert cell["tier_used"] >= 1

    def test_heatmap_turns_total_the_scored_turns(self, scored):
        cells = scored["waste"]["complexity_by_tier"]
        assert sum(c["turns"] for c in cells) == scored["waste"]["scored_turns"]

    def test_leaderboard_is_ordered_by_waste(self, scored):
        values = [Decimal(r["estimated_waste"]) for r in scored["waste"]["leaderboard"]]
        assert values == sorted(values, reverse=True)

    def test_leaderboard_rows_are_explainable(self, scored):
        """Every row must justify itself, not just carry a number."""
        for row in scored["waste"]["leaderboard"]:
            assert row["rationale"]
            assert row["recommendation"]
            assert row["prompt"] is not None

    def test_leaderboard_exposes_component_split(self, scored):
        row = scored["waste"]["leaderboard"][0]
        assert Decimal(row["overshoot"]) + Decimal(row["bloat"]) >= 0

    def test_unmeasured_bloat_is_counted_not_hidden(self, scored):
        assert "unmeasured_bloat_turns" in scored["waste"]

    def test_category_distribution_totals_scored_turns(self, scored):
        rows = scored["waste"]["category_distribution"]
        assert sum(r["turns"] for r in rows) == scored["waste"]["scored_turns"]

    def test_escalation_is_reported(self, scored):
        assert "escalated" in scored["waste"]["flags"]
        assert "escalation_changed_tier" in scored["waste"]["flags"]


class TestMoneySerialisation:
    def test_money_is_a_string_not_a_float(self, spend_only):
        assert isinstance(spend_only["overview"]["total_cost"], str)
        assert all(isinstance(r["cost"], str) for r in spend_only["cost_by_model"])

    def test_money_survives_round_trip_exactly(self, spend_only):
        table = default_table()
        expected = sum(
            (table.cost_of(c) for t in parse_projects(FIXTURES) for c in t.calls),
            Decimal(0),
        )
        assert Decimal(spend_only["overview"]["total_cost"]) == expected

    def test_rate_table_provenance_is_included(self, spend_only):
        assert spend_only["rate_table"]["version"] >= 1
        assert spend_only["rate_table"]["updated"]


class TestClassificationIsNeverImplicit:
    def test_building_analysis_does_not_classify_by_default(self, tmp_path):
        """Opening the dashboard must not spend money."""

        class ExplodingClient:
            class messages:
                @staticmethod
                def parse(**kwargs):
                    raise AssertionError("classification was attempted implicitly")

        cache = ClassificationCache(tmp_path / "c.db")
        Classifier(client=ExplodingClient(), cache=cache)
        build_analysis(FIXTURES, cache_path=tmp_path / "c.db")

    def test_cached_classifications_are_reused(self, tmp_path):
        cache_path = tmp_path / "c.db"
        turns = [t for t in parse_projects(FIXTURES) if t.is_scorable]

        with ClassificationCache(cache_path) as cache:
            classifier = Classifier(cache=cache)
            key = cache_key(turns[0].prompt_text, PROMPT_VERSION, classifier.pipeline_id)
            cache.put(key, turns[0].prompt_text, PROMPT_VERSION, classification())

        payload = build_analysis(FIXTURES, cache_path=cache_path).to_payload()
        assert payload["overview"]["classified_turns"] == 1
        assert payload["waste"] is not None


class TestApi:
    @pytest.fixture
    def client(self, monkeypatch, tmp_path):
        import tokenlens.api as api

        monkeypatch.setattr(api, "PROJECTS_PATH", FIXTURES)
        monkeypatch.setattr(api, "CACHE_PATH", tmp_path / "c.db")
        return TestClient(api.app)

    def test_health_reports_readiness(self, client):
        body = client.get("/api/health").json()
        assert body["status"] == "ok"
        assert body["projects_path_exists"]

    def test_analysis_returns_spend_data(self, client):
        response = client.get("/api/analysis")
        assert response.status_code == 200
        assert Decimal(response.json()["overview"]["total_cost"]) > 0

    def test_analysis_is_json_serialisable(self, client):
        """Guards against a Decimal or Enum leaking into the payload."""
        assert client.get("/api/analysis").status_code == 200

    def test_classify_refuses_without_a_key(self, client, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        response = client.post("/api/classify")
        assert response.status_code == 400
        assert "ANTHROPIC_API_KEY" in response.json()["detail"]

    def test_missing_log_directory_is_a_clear_404(self, monkeypatch, tmp_path):
        import tokenlens.api as api

        monkeypatch.setattr(api, "PROJECTS_PATH", tmp_path / "nope")
        response = TestClient(api.app).get("/api/analysis")
        assert response.status_code == 404
        assert "TOKENLENS_PROJECTS" in response.json()["detail"]
