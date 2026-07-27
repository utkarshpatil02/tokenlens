"""Validation tests.

Kappa is checked against values computed by hand from the formula rather than
against whatever the implementation happens to return, since a plausible-looking
but wrong kappa is exactly the sort of error that would survive review and then
misrepresent the project's headline result.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest

from tokenlens.classify.schema import Category, Classification, Complexity
from tokenlens.models import Call, Profile, Turn
from tokenlens.validation import (
    LabelError,
    LabelSet,
    Strength,
    agreement,
    build_report,
    confusion_grid,
    export_template,
    format_report,
    strength_of,
)
from tokenlens.validation.report import COMPLEXITY_ORDER
from tokenlens.validate_cli import main

WHEN = datetime(2026, 7, 20, tzinfo=timezone.utc)


def turn(turn_id: str, prompt: str) -> Turn:
    return Turn(
        turn_id=turn_id,
        profile=Profile.AGENTIC,
        timestamp=WHEN,
        calls=[Call("claude-opus-5", WHEN, output_tokens=100)],
        prompt_text=prompt,
    )


def found(
    category=Category.CODING,
    complexity=Complexity.TRIVIAL,
    escalated=False,
    base_complexity=None,
    base_category=None,
) -> Classification:
    return Classification(
        category=category,
        complexity=complexity,
        confidence=0.9,
        rationale="r",
        model="claude-haiku-4-5",
        escalated=escalated,
        base_complexity=base_complexity,
        base_category=base_category,
        base_confidence=0.3 if escalated else None,
    )


def write_labels(path: Path, rows: list[tuple[str, str, str]]) -> Path:
    lines = ["turn_id,prompt,category,complexity,notes"]
    lines += [f"{tid},prompt text,{cat},{cx}," for tid, cat, cx in rows]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


class TestKappaAgainstHandComputedValues:
    def test_perfect_agreement_is_one(self):
        result = agreement(["a", "b", "a", "b"], ["a", "b", "a", "b"])
        assert result.observed == 1.0
        assert result.kappa == pytest.approx(1.0)

    def test_known_two_by_two_case(self):
        """p_o = 0.8; p_e = (.5*.6)+(.5*.4) = 0.5; k = (.8-.5)/.5 = 0.6"""
        reference = ["a", "a", "a", "a", "a", "b", "b", "b", "b", "b"]
        predicted = ["a", "a", "a", "a", "b", "a", "b", "b", "b", "b"]
        result = agreement(reference, predicted)
        assert result.observed == pytest.approx(0.8)
        assert result.expected == pytest.approx(0.5)
        assert result.kappa == pytest.approx(0.6)

    def test_chance_level_agreement_is_about_zero(self):
        """Raw agreement of 50% on a balanced 2-class set is worth nothing."""
        result = agreement(["a", "a", "b", "b"], ["a", "b", "a", "b"])
        assert result.observed == pytest.approx(0.5)
        assert result.kappa == pytest.approx(0.0)

    def test_systematically_wrong_scores_negative(self):
        result = agreement(["a", "a", "b", "b"], ["b", "b", "a", "a"])
        assert result.kappa < 0
        assert result.strength is Strength.POOR

    def test_raw_agreement_flatters_a_skewed_distribution(self):
        """The reason kappa is the headline figure and raw agreement is not."""
        reference = ["moderate"] * 7 + ["trivial", "complex", "complex"]
        always_moderate = ["moderate"] * 10
        result = agreement(reference, always_moderate)
        assert result.observed == pytest.approx(0.7)
        assert result.kappa == pytest.approx(0.0)


class TestWeightedKappa:
    """Complexity is ordinal, so distance between labels has to count."""

    def test_adjacent_confusion_beats_distant_confusion(self):
        reference = ["trivial", "moderate", "complex", "trivial"]
        adjacent = ["moderate", "moderate", "complex", "trivial"]
        distant = ["complex", "moderate", "complex", "trivial"]

        near = agreement(reference, adjacent, ordinal=COMPLEXITY_ORDER)
        far = agreement(reference, distant, ordinal=COMPLEXITY_ORDER)
        assert near.kappa > far.kappa

    def test_unweighted_cannot_tell_them_apart(self):
        """Establishes that the weighting is doing real work."""
        reference = ["trivial", "moderate", "complex", "trivial"]
        adjacent = ["moderate", "moderate", "complex", "trivial"]
        distant = ["complex", "moderate", "complex", "trivial"]
        assert agreement(reference, adjacent).kappa == agreement(reference, distant).kappa

    def test_weighted_flag_is_recorded(self):
        result = agreement(["trivial"], ["trivial"], ordinal=COMPLEXITY_ORDER)
        assert result.weighted

    def test_ordinal_labels_keep_their_declared_order(self):
        result = agreement(["complex"], ["trivial"], ordinal=COMPLEXITY_ORDER)
        assert result.labels == COMPLEXITY_ORDER


class TestDegenerateCases:
    def test_single_constant_label_with_full_agreement_is_one(self):
        """p_e is 1 here, so the formula divides by zero without a guard."""
        result = agreement(["a", "a", "a"], ["a", "a", "a"])
        assert result.kappa == 1.0

    def test_empty_input_does_not_raise(self):
        assert agreement([], []).kappa == 0.0

    def test_length_mismatch_is_rejected(self):
        with pytest.raises(ValueError, match="differ in length"):
            agreement(["a"], ["a", "b"])


class TestStrengthBands:
    @pytest.mark.parametrize(
        "kappa,expected",
        [
            (-0.1, Strength.POOR),
            (0.15, Strength.SLIGHT),
            (0.35, Strength.FAIR),
            (0.55, Strength.MODERATE),
            (0.75, Strength.SUBSTANTIAL),
            (0.95, Strength.ALMOST_PERFECT),
        ],
    )
    def test_bands(self, kappa, expected):
        assert strength_of(kappa) is expected


class TestConfusion:
    def test_disagreements_exclude_the_diagonal(self):
        result = agreement(["a", "a", "b"], ["a", "b", "b"])
        assert result.disagreements == [(("a", "b"), 1)]

    def test_grid_rows_and_totals_line_up(self):
        result = agreement(["a", "a", "b"], ["a", "b", "b"])
        grid = confusion_grid(result)
        assert grid[0][0] == "ref \\ pred"
        assert grid[-1][-1] == "3"


class TestLabelLoading:
    def test_loads_completed_rows(self, tmp_path):
        path = write_labels(
            tmp_path / "l.csv", [("t1", "coding", "trivial"), ("t2", "research", "complex")]
        )
        labels = LabelSet.load(path)
        assert len(labels) == 2
        assert labels.get("t2").complexity is Complexity.COMPLEX

    def test_blank_rows_are_skipped_not_rejected(self, tmp_path):
        """An unlabelled row is work not yet done."""
        path = tmp_path / "l.csv"
        path.write_text(
            "turn_id,prompt,category,complexity,notes\nt1,p,coding,trivial,\nt2,p,,,\n",
            encoding="utf-8",
        )
        assert len(LabelSet.load(path)) == 1

    def test_half_filled_row_is_an_error(self, tmp_path):
        path = tmp_path / "l.csv"
        path.write_text(
            "turn_id,prompt,category,complexity,notes\nt1,p,coding,,\n", encoding="utf-8"
        )
        with pytest.raises(LabelError, match="both category and complexity"):
            LabelSet.load(path)

    def test_unknown_category_names_the_line_and_the_options(self, tmp_path):
        path = write_labels(tmp_path / "l.csv", [("t1", "archaeology", "trivial")])
        with pytest.raises(LabelError, match="line 2.*archaeology"):
            LabelSet.load(path)

    def test_unknown_complexity_is_rejected(self, tmp_path):
        path = write_labels(tmp_path / "l.csv", [("t1", "coding", "impossible")])
        with pytest.raises(LabelError, match="impossible"):
            LabelSet.load(path)

    def test_duplicate_turn_id_is_rejected(self, tmp_path):
        path = write_labels(
            tmp_path / "l.csv", [("t1", "coding", "trivial"), ("t1", "writing", "complex")]
        )
        with pytest.raises(LabelError, match="duplicate"):
            LabelSet.load(path)

    def test_missing_column_is_reported_clearly(self, tmp_path):
        path = tmp_path / "l.csv"
        path.write_text("turn_id,prompt\nt1,p\n", encoding="utf-8")
        with pytest.raises(LabelError, match="missing required column"):
            LabelSet.load(path)

    def test_labels_are_case_insensitive(self, tmp_path):
        path = write_labels(tmp_path / "l.csv", [("t1", "CODING", "Trivial")])
        assert LabelSet.load(path).get("t1").category is Category.CODING

    def test_bom_prefixed_file_loads(self, tmp_path):
        """Excel writes a BOM when saving CSV."""
        path = tmp_path / "l.csv"
        path.write_text(
            "﻿turn_id,prompt,category,complexity,notes\nt1,p,coding,trivial,\n",
            encoding="utf-8",
        )
        assert len(LabelSet.load(path)) == 1

    def test_overlap_is_sorted_for_aligned_comparison(self, tmp_path):
        a = LabelSet.load(
            write_labels(
                tmp_path / "a.csv",
                [("t2", "coding", "trivial"), ("t1", "coding", "trivial")],
            )
        )
        b = LabelSet.load(
            write_labels(
                tmp_path / "b.csv",
                [("t1", "coding", "trivial"), ("t3", "coding", "trivial")],
            )
        )
        assert a.overlap(b) == ["t1"]


class TestExportTemplate:
    def test_label_columns_are_left_blank(self, tmp_path):
        """Labelling must not be anchored to classifier output."""
        path = tmp_path / "out.csv"
        export_template([turn("t1", "do a thing")], path)
        body = path.read_text(encoding="utf-8")
        assert "t1,do a thing,,," in body

    def test_prompt_newlines_are_collapsed(self, tmp_path):
        """One prompt has to stay one spreadsheet row."""
        path = tmp_path / "out.csv"
        export_template([turn("t1", "line one\nline two")], path)
        assert len(path.read_text(encoding="utf-8").strip().splitlines()) == 2

    def test_turns_without_prompt_text_are_excluded(self, tmp_path):
        blank = turn("t2", "x")
        blank.prompt_text = None
        assert export_template([blank], tmp_path / "out.csv") == 0

    def test_limit_caps_the_sheet(self, tmp_path):
        turns = [turn(f"t{i}", f"prompt {i}") for i in range(10)]
        assert export_template(turns, tmp_path / "out.csv", limit=4) == 4

    def test_exported_sheet_round_trips_once_filled(self, tmp_path):
        path = tmp_path / "out.csv"
        export_template([turn("t1", "do a thing")], path)
        filled = path.read_text(encoding="utf-8").replace("t1,do a thing,,,", "t1,do a thing,coding,trivial,")
        path.write_text(filled, encoding="utf-8")
        assert LabelSet.load(path).get("t1").complexity is Complexity.TRIVIAL


class TestReport:
    def _setup(self, tmp_path, classifications, rows):
        turns = [turn(tid, f"prompt {tid}") for tid, _, _ in rows]
        labels = LabelSet.load(write_labels(tmp_path / "l.csv", rows))
        return build_report(turns, classifications, labels)

    def test_compares_only_turns_that_are_both_labelled_and_classified(self, tmp_path):
        rows = [("t1", "coding", "trivial"), ("t2", "coding", "trivial")]
        report = self._setup(tmp_path, {"t1": found()}, rows)
        assert report.labelled == 2
        assert report.compared == 1

    def test_perfect_agreement_reports_kappa_one(self, tmp_path):
        rows = [
            ("t1", "coding", "trivial"),
            ("t2", "research", "complex"),
            ("t3", "writing", "moderate"),
        ]
        classifications = {
            "t1": found(Category.CODING, Complexity.TRIVIAL),
            "t2": found(Category.RESEARCH, Complexity.COMPLEX),
            "t3": found(Category.WRITING, Complexity.MODERATE),
        }
        report = self._setup(tmp_path, classifications, rows)
        assert report.category.kappa == pytest.approx(1.0)
        assert report.complexity.kappa == pytest.approx(1.0)

    def test_pre_escalation_answer_is_used_for_the_before_figure(self, tmp_path):
        """Escalation only earns its cost if the figure improves."""
        rows = [("t1", "coding", "complex"), ("t2", "coding", "trivial")]
        classifications = {
            # Escalation corrected trivial -> complex, matching the label.
            "t1": found(
                complexity=Complexity.COMPLEX,
                escalated=True,
                base_complexity=Complexity.TRIVIAL,
                base_category=Category.CODING,
            ),
            "t2": found(complexity=Complexity.TRIVIAL),
        }
        report = self._setup(tmp_path, classifications, rows)
        assert report.complexity.kappa > report.complexity_before.kappa
        assert report.complexity_kappa_delta > 0

    def test_escalation_counts_are_reported(self, tmp_path):
        rows = [("t1", "coding", "complex")]
        classifications = {
            "t1": found(
                complexity=Complexity.COMPLEX,
                escalated=True,
                base_complexity=Complexity.TRIVIAL,
            )
        }
        report = self._setup(tmp_path, classifications, rows)
        assert report.escalated == 1
        assert report.escalation_changed_tier == 1

    def test_non_escalated_turns_have_identical_before_and_after(self, tmp_path):
        rows = [("t1", "coding", "trivial"), ("t2", "research", "complex")]
        classifications = {
            "t1": found(Category.CODING, Complexity.TRIVIAL),
            "t2": found(Category.RESEARCH, Complexity.MODERATE),
        }
        report = self._setup(tmp_path, classifications, rows)
        assert report.complexity.kappa == report.complexity_before.kappa

    def test_disagreement_examples_are_captured(self, tmp_path):
        rows = [("t1", "coding", "complex")]
        report = self._setup(tmp_path, {"t1": found(complexity=Complexity.TRIVIAL)}, rows)
        assert ("complex", "trivial") in report.examples

    def test_human_baseline_is_computed_on_the_shared_subset(self, tmp_path):
        rows = [("t1", "coding", "trivial"), ("t2", "coding", "complex")]
        turns = [turn(tid, f"prompt {tid}") for tid, _, _ in rows]
        first = LabelSet.load(write_labels(tmp_path / "a.csv", rows))
        second = LabelSet.load(
            write_labels(tmp_path / "b.csv", [("t1", "coding", "trivial")])
        )
        report = build_report(
            turns, {"t1": found(), "t2": found()}, first, second_labels=second
        )
        assert report.human_subset == 1
        assert report.human is not None

    def test_human_baseline_is_absent_when_not_collected(self, tmp_path):
        report = self._setup(tmp_path, {"t1": found()}, [("t1", "coding", "trivial")])
        assert report.human is None


class TestReportFormatting:
    def _report(self, tmp_path):
        rows = [
            ("t1", "coding", "trivial"),
            ("t2", "research", "complex"),
            ("t3", "writing", "moderate"),
        ]
        turns = [turn(tid, f"prompt {tid}") for tid, _, _ in rows]
        labels = LabelSet.load(write_labels(tmp_path / "l.csv", rows))
        classifications = {
            "t1": found(Category.CODING, Complexity.TRIVIAL),
            "t2": found(Category.RESEARCH, Complexity.MODERATE),
            "t3": found(Category.WRITING, Complexity.MODERATE),
        }
        return build_report(turns, classifications, labels)

    def test_reports_both_raw_and_kappa(self, tmp_path):
        text = format_report(self._report(tmp_path))
        assert "kappa" in text
        assert "raw" in text

    def test_explains_why_kappa_leads(self, tmp_path):
        text = format_report(self._report(tmp_path))
        assert "skewed" in text

    def test_flags_a_missing_human_baseline(self, tmp_path):
        text = format_report(self._report(tmp_path))
        assert "not collected" in text

    def test_says_when_escalation_was_never_exercised(self, tmp_path):
        text = format_report(self._report(tmp_path))
        assert "escalation is untested" in text

    def test_includes_the_confusion_matrix(self, tmp_path):
        text = format_report(self._report(tmp_path))
        assert "confusion matrix" in text

    def test_points_at_the_score_invariant_tests(self, tmp_path):
        text = format_report(self._report(tmp_path))
        assert "test_scoring.py" in text

    def test_empty_comparison_says_so_plainly(self, tmp_path):
        rows = [("t1", "coding", "trivial")]
        turns = [turn("t1", "p")]
        labels = LabelSet.load(write_labels(tmp_path / "l.csv", rows))
        text = format_report(build_report(turns, {}, labels))
        assert "no labelled prompt has been classified" in text

    def test_json_shape_is_serialisable(self, tmp_path):
        import json

        json.dumps(self._report(tmp_path).as_dict())


class TestCli:
    def test_export_writes_a_sheet(self, tmp_path, capsys, monkeypatch):
        fixtures = Path(__file__).parent / "fixtures"
        out = tmp_path / "labels.csv"
        assert main(["export", str(out), "--path", str(fixtures)]) == 0
        assert out.exists()
        assert "Fill in" in capsys.readouterr().out

    def test_export_rejects_a_missing_directory(self, tmp_path):
        with pytest.raises(SystemExit):
            main(["export", str(tmp_path / "o.csv"), "--path", str(tmp_path / "nope")])

    def test_report_rejects_a_missing_label_file(self, tmp_path):
        with pytest.raises(SystemExit):
            main(["report", str(tmp_path / "nope.csv")])

    def test_report_rejects_an_empty_label_file(self, tmp_path):
        path = tmp_path / "l.csv"
        path.write_text("turn_id,prompt,category,complexity,notes\n", encoding="utf-8")
        with pytest.raises(SystemExit):
            main(["report", str(path)])

    def test_report_exits_nonzero_when_nothing_is_classified(self, tmp_path, capsys):
        fixtures = Path(__file__).parent / "fixtures"
        path = write_labels(tmp_path / "l.csv", [("x", "coding", "trivial")])
        code = main(
            [
                "report",
                str(path),
                "--path",
                str(fixtures),
                "--cache",
                str(tmp_path / "empty.db"),
            ]
        )
        assert code == 1
        assert "classify_cli" in capsys.readouterr().out
