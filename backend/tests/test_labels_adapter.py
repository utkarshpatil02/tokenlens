"""Hand labels as classifier stand-in.

The free path: scoring, the heatmap, and the leaderboard all work from hand
labels, so the pipeline runs end to end with no API key.

The risk this creates is subtle and worth guarding hard. If labels are fed in as
"predictions" and then validated against the label set they came from, the report
shows perfect agreement while measuring nothing — a number that looks like the
project's headline result and is actually meaningless.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest

from tokenlens.analysis import build_analysis
from tokenlens.classify.schema import Category, Classification, Complexity
from tokenlens.ingest import parse_projects
from tokenlens.validation import LabelSet, SelfComparisonError, build_report

FIXTURES = Path(__file__).parent / "fixtures"
WHEN = datetime(2026, 7, 20, tzinfo=timezone.utc)


def label_file(path: Path, turn_ids: list[str], category="coding", complexity="trivial"):
    lines = ["turn_id,prompt,category,complexity,notes"]
    lines += [f"{tid},prompt,{category},{complexity}," for tid in turn_ids]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


@pytest.fixture
def real_turn_ids():
    return [t.turn_id for t in parse_projects(FIXTURES) if t.is_scorable]


class TestConversion:
    def test_labels_become_classifications(self, tmp_path):
        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1", "t2"]))
        found = labels.to_classifications()
        assert set(found) == {"t1", "t2"}
        assert found["t1"].category is Category.CODING
        assert found["t1"].complexity is Complexity.TRIVIAL

    def test_confidence_is_certain(self, tmp_path):
        """These are the reference labels, not a prediction carrying doubt."""
        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1"]))
        assert labels.to_classifications()["t1"].confidence == 1.0

    def test_marked_as_human_sourced(self, tmp_path):
        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1"]))
        found = labels.to_classifications()["t1"]
        assert found.is_human
        assert found.model.startswith("human:")

    def test_source_filename_is_recorded(self, tmp_path):
        labels = LabelSet.load(label_file(tmp_path / "reviewer.csv", ["t1"]))
        assert "reviewer.csv" in labels.to_classifications()["t1"].model

    def test_notes_become_the_rationale(self, tmp_path):
        path = tmp_path / "l.csv"
        path.write_text(
            "turn_id,prompt,category,complexity,notes\n"
            "t1,p,coding,complex,needs whole-repo context\n",
            encoding="utf-8",
        )
        found = LabelSet.load(path).to_classifications()["t1"]
        assert found.rationale == "needs whole-repo context"

    def test_missing_notes_fall_back_to_a_plain_marker(self, tmp_path):
        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1"]))
        assert labels.to_classifications()["t1"].rationale == "hand-labelled"

    def test_labels_are_never_marked_escalated(self, tmp_path):
        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1"]))
        assert not labels.to_classifications()["t1"].escalated

    def test_required_tier_flows_through(self, tmp_path):
        labels = LabelSet.load(
            label_file(tmp_path / "l.csv", ["t1"], complexity="complex")
        )
        assert labels.to_classifications()["t1"].required_tier == 3

    def test_busywork_is_still_zero_value(self, tmp_path):
        labels = LabelSet.load(
            label_file(tmp_path / "l.csv", ["t1"], category="busywork")
        )
        assert labels.to_classifications()["t1"].is_zero_value

    def test_classifier_output_is_not_marked_human(self):
        from tokenlens.classify.schema import Classification

        assert not Classification(
            Category.CODING, Complexity.TRIVIAL, 0.9, "r", "claude-haiku-4-5"
        ).is_human


class TestSelfComparisonGuard:
    """Validating labels against themselves would report a meaningless 1.0."""

    def test_refuses_to_score_labels_against_themselves(self, tmp_path):
        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1", "t2"]))
        turns = parse_projects(FIXTURES)
        with pytest.raises(SelfComparisonError, match="measure nothing"):
            build_report(turns, labels.to_classifications(), labels)

    def test_error_names_the_way_forward(self, tmp_path):
        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1"]))
        with pytest.raises(SelfComparisonError, match="classify_cli"):
            build_report([], labels.to_classifications(), labels)

    def test_real_predictions_still_validate(self, tmp_path):
        from tokenlens.classify.schema import Classification

        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1"]))
        predictions = {
            "t1": Classification(
                Category.CODING, Complexity.TRIVIAL, 0.9, "r", "claude-haiku-4-5"
            )
        }
        assert build_report([], predictions, labels).compared == 1

    def test_partial_human_overlap_is_allowed(self, tmp_path):
        """A mixed set still contains real predictions worth measuring."""
        from tokenlens.classify.schema import Classification

        labels = LabelSet.load(label_file(tmp_path / "l.csv", ["t1", "t2"]))
        mixed = labels.to_classifications()
        mixed["t2"] = Classification(
            Category.CODING, Complexity.TRIVIAL, 0.9, "r", "claude-haiku-4-5"
        )
        assert build_report([], mixed, labels).compared == 2


class TestAnalysisIntegration:
    def test_waste_section_appears_without_an_api_key(self, tmp_path, real_turn_ids):
        """The whole point: a working waste analysis for free."""
        path = label_file(tmp_path / "l.csv", real_turn_ids)
        payload = build_analysis(FIXTURES, labels_path=path).to_payload()
        assert payload["waste"] is not None
        assert payload["waste"]["scored_turns"] == len(real_turn_ids)

    def test_source_is_reported_as_hand_labelled(self, tmp_path, real_turn_ids):
        path = label_file(tmp_path / "l.csv", real_turn_ids)
        payload = build_analysis(FIXTURES, labels_path=path).to_payload()
        source = payload["waste"]["source"]

        assert source["kind"] == "hand-labelled"
        assert source["human_turns"] == len(real_turn_ids)
        # No model produced these, so none may be named as though one had.
        assert source["models"] == []

    def test_source_names_the_models_that_produced_the_labels(
        self, tmp_path, real_turn_ids
    ):
        """A figure whose origin cannot be traced is the thing to avoid."""
        analysis = build_analysis(FIXTURES, labels_path=label_file(
            tmp_path / "l.csv", real_turn_ids
        ))
        # Re-label as though a classifier had done it, with one escalation, so
        # the payload has to attribute two models rather than one.
        models = ["claude-haiku-4-5"] * len(real_turn_ids)
        models[0] = "claude-sonnet-5"
        analysis.classifications = {
            turn_id: Classification(
                Category.CODING, Complexity.TRIVIAL, 0.9, "r", model
            )
            for turn_id, model in zip(real_turn_ids, models)
        }
        source = analysis.to_payload()["waste"]["source"]

        assert source["kind"] == "classifier"
        assert source["human_turns"] == 0
        # Most-used first, so the workhorse leads and the escalation follows.
        assert source["models"] == [
            {"model": "claude-haiku-4-5", "turns": len(real_turn_ids) - 1},
            {"model": "claude-sonnet-5", "turns": 1},
        ]

    def test_source_is_mixed_when_a_person_judged_only_some(
        self, tmp_path, real_turn_ids
    ):
        analysis = build_analysis(FIXTURES, labels_path=label_file(
            tmp_path / "l.csv", real_turn_ids
        ))
        human = analysis.classifications[real_turn_ids[0]]
        analysis.classifications = {
            real_turn_ids[0]: human,
            **{
                turn_id: Classification(
                    Category.CODING, Complexity.TRIVIAL, 0.9, "r", "gemini-3.5-flash-lite"
                )
                for turn_id in real_turn_ids[1:]
            },
        }
        source = analysis.to_payload()["waste"]["source"]

        assert source["kind"] == "mixed"
        assert source["human_turns"] == 1
        # The human turn is not attributed to the model that did the others.
        assert source["models"] == [
            {"model": "gemini-3.5-flash-lite", "turns": len(real_turn_ids) - 1}
        ]

    def test_source_is_classifier_when_no_labels_are_used(self, tmp_path):
        payload = build_analysis(FIXTURES, cache_path=tmp_path / "c.db").to_payload()
        assert payload["waste"] is None  # nothing classified, nothing to source

    def test_labels_for_unknown_turns_are_ignored(self, tmp_path, real_turn_ids):
        """A stale label file must not invent turns that no longer exist."""
        path = label_file(tmp_path / "l.csv", [*real_turn_ids, "ghost-turn"])
        analysis = build_analysis(FIXTURES, labels_path=path)
        assert "ghost-turn" not in analysis.classifications

    def test_leaderboard_carries_the_hand_written_rationale(self, tmp_path, real_turn_ids):
        path = label_file(tmp_path / "l.csv", real_turn_ids)
        payload = build_analysis(FIXTURES, labels_path=path).to_payload()
        assert payload["waste"]["leaderboard"][0]["rationale"] == "hand-labelled"

    def test_partially_labelled_corpus_scores_only_what_is_labelled(
        self, tmp_path, real_turn_ids
    ):
        path = label_file(tmp_path / "l.csv", real_turn_ids[:1])
        payload = build_analysis(FIXTURES, labels_path=path).to_payload()
        assert payload["waste"]["scored_turns"] == 1
        # Spend totals still cover every turn, labelled or not.
        assert payload["overview"]["turns"] > 1

    def test_busywork_label_forfeits_the_whole_cost(self, tmp_path, real_turn_ids):
        path = label_file(tmp_path / "l.csv", real_turn_ids, category="busywork")
        payload = build_analysis(FIXTURES, labels_path=path).to_payload()
        waste = payload["waste"]
        assert waste["flags"]["zero_value"] == len(real_turn_ids)
        assert waste["total_waste"] == waste["scored_cost"]


class TestApiIntegration:
    def test_health_reports_label_availability(self, monkeypatch, tmp_path):
        from fastapi.testclient import TestClient

        import tokenlens.api as api

        path = label_file(tmp_path / "l.csv", ["t1"])
        monkeypatch.setattr(api, "PROJECTS_PATH", FIXTURES)
        monkeypatch.setattr(api, "LABELS_PATH", path)
        body = TestClient(api.app).get("/api/health").json()
        assert body["has_labels"]

    def test_missing_label_file_is_a_clear_404(self, monkeypatch, tmp_path):
        from fastapi.testclient import TestClient

        import tokenlens.api as api

        monkeypatch.setattr(api, "PROJECTS_PATH", FIXTURES)
        monkeypatch.setattr(api, "LABELS_PATH", tmp_path / "missing.csv")
        response = TestClient(api.app).get("/api/analysis")
        assert response.status_code == 404
        assert "TOKENLENS_LABELS" in response.json()["detail"]
