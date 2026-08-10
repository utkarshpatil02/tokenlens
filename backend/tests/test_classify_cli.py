"""Classification CLI tests.

Everything here runs with `--dry-run`, so the suite never needs a key and never
spends anything. The behaviour under test is prompt *selection*, which is the
part that decides what a billable run costs and — for `--labels` — whether the
resulting kappa describes the reference set it claims to.
"""

import csv
from pathlib import Path

import pytest

from tokenlens.classify_cli import main

FIXTURES = Path(__file__).parent / "fixtures"

# Two of the four scorable prompts in the fixture corpus.
LABELLED = ("sess-abc:p1", "sess-abc:p2")


def write_labels(path: Path, turn_ids, *, category="coding", complexity="moderate"):
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["turn_id", "prompt", "category", "complexity", "notes"])
        for turn_id in turn_ids:
            writer.writerow([turn_id, "prompt text", category, complexity, ""])
    return path


@pytest.fixture
def cache(tmp_path):
    return tmp_path / "classifications.db"


def run(capsys, *args):
    assert main(list(args)) == 0
    return capsys.readouterr().out


class TestLabelTargeting:
    def test_classifies_only_the_labelled_prompts(self, tmp_path, cache, capsys):
        labels = write_labels(tmp_path / "labels.csv", LABELLED)

        out = run(capsys, str(FIXTURES), "--labels", str(labels), "--cache", str(cache), "--dry-run")

        # Four prompts are scorable; only the two with labels are in scope.
        assert "prompts        2" in out
        assert "to classify    2" in out

    def test_without_labels_the_whole_corpus_is_in_scope(self, tmp_path, cache, capsys):
        out = run(capsys, str(FIXTURES), "--cache", str(cache), "--dry-run")

        assert "prompts        4" in out

    def test_unfilled_rows_are_not_treated_as_labels(self, tmp_path, cache, capsys):
        # A sheet mid-labelling: one row done, one still blank. Only the done
        # one has anything to compare against.
        path = tmp_path / "partial.csv"
        with open(path, "w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["turn_id", "prompt", "category", "complexity", "notes"])
            writer.writerow([LABELLED[0], "p", "coding", "moderate", ""])
            writer.writerow([LABELLED[1], "p", "", "", ""])

        out = run(capsys, str(FIXTURES), "--labels", str(path), "--cache", str(cache), "--dry-run")

        assert "prompts        1" in out

    def test_warns_about_labels_whose_turns_are_gone(self, tmp_path, cache, capsys):
        labels = write_labels(tmp_path / "labels.csv", (*LABELLED, "sess-abc:vanished"))

        out = run(capsys, str(FIXTURES), "--labels", str(labels), "--cache", str(cache), "--dry-run")

        # Silently comparing 2 of 3 would report a kappa over a quietly
        # different reference set than the one being claimed.
        assert "1 of 3 labelled turn(s) are not in" in out
        assert "prompts        2" in out

    def test_no_overlap_at_all_is_an_error_not_an_empty_run(self, tmp_path, cache):
        labels = write_labels(tmp_path / "labels.csv", ("nothing:matches",))

        with pytest.raises(SystemExit) as caught:
            main([str(FIXTURES), "--labels", str(labels), "--cache", str(cache), "--dry-run"])

        assert caught.value.code != 0

    def test_unreadable_label_sheet_is_an_error(self, tmp_path, cache):
        missing = tmp_path / "does-not-exist.csv"

        with pytest.raises(SystemExit) as caught:
            main([str(FIXTURES), "--labels", str(missing), "--cache", str(cache), "--dry-run"])

        assert caught.value.code != 0

    def test_a_sheet_missing_its_columns_is_an_error(self, tmp_path, cache):
        path = tmp_path / "wrong.csv"
        path.write_text("id,text\nfoo,bar\n", encoding="utf-8")

        with pytest.raises(SystemExit) as caught:
            main([str(FIXTURES), "--labels", str(path), "--cache", str(cache), "--dry-run"])

        assert caught.value.code != 0


class TestDryRun:
    def test_makes_no_api_call_and_says_so(self, cache, capsys):
        # The whole suite depends on this: no key is set anywhere in CI.
        out = run(capsys, str(FIXTURES), "--cache", str(cache), "--dry-run")

        assert "no API calls made" in out

    def test_limit_still_caps_a_targeted_run(self, tmp_path, cache, capsys):
        labels = write_labels(tmp_path / "labels.csv", LABELLED)

        out = run(
            capsys,
            str(FIXTURES),
            "--labels",
            str(labels),
            "--limit",
            "1",
            "--cache",
            str(cache),
            "--dry-run",
        )

        assert "prompts        1" in out
