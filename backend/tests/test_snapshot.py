"""Snapshot tests.

Publishing is irreversible: a file on a public URL may be cached and indexed
beyond anyone's control. These tests treat a redaction failure as the serious
defect it is — one that discloses private data silently.
"""

import json
from pathlib import Path

import pytest

from tokenlens.snapshot import assert_redacted, build_snapshot, main, redact

FIXTURES = Path(__file__).parent / "fixtures"


def payload_with_leaderboard(**overrides) -> dict:
    row = {
        "turn_id": "s:1",
        "prompt": "refactor the billing module before the audit",
        "rationale": "the user is refactoring billing code ahead of an audit",
        "actual_cost": "1.00",
        "estimated_waste": "0.50",
        **overrides,
    }
    return {"overview": {}, "waste": {"leaderboard": [row]}}


class TestRedaction:
    def test_prompt_text_is_removed(self):
        result = redact(payload_with_leaderboard())
        prompt = result["waste"]["leaderboard"][0]["prompt"]
        assert "billing" not in prompt
        assert "redacted" in prompt

    def test_rationale_is_removed_too(self):
        """It is written about the prompt and routinely restates its content."""
        result = redact(payload_with_leaderboard())
        assert "billing" not in result["waste"]["leaderboard"][0]["rationale"]

    def test_prompt_length_survives_as_a_bare_count(self):
        """Explains why a turn is expensive without disclosing content."""
        result = redact(payload_with_leaderboard(prompt="x" * 42))
        assert "42 chars" in result["waste"]["leaderboard"][0]["prompt"]

    def test_figures_are_untouched(self):
        result = redact(payload_with_leaderboard())
        row = result["waste"]["leaderboard"][0]
        assert row["actual_cost"] == "1.00"
        assert row["estimated_waste"] == "0.50"

    def test_missing_prompt_is_labelled_not_crashed(self):
        result = redact(payload_with_leaderboard(prompt=None))
        assert result["waste"]["leaderboard"][0]["prompt"] == "(no prompt text)"

    def test_absent_waste_section_is_handled(self):
        assert redact({"overview": {}, "waste": None})["waste"] is None


class TestRedactionGuard:
    """The guard exists because a silent redaction bug publishes private data."""

    def test_guard_catches_unredacted_prompt(self):
        with pytest.raises(AssertionError, match="prompt"):
            assert_redacted(payload_with_leaderboard())

    def test_guard_catches_unredacted_rationale(self):
        leaked = redact(payload_with_leaderboard())
        leaked["waste"]["leaderboard"][0]["rationale"] = "user asked about billing"
        with pytest.raises(AssertionError, match="rationale"):
            assert_redacted(leaked)

    def test_guard_passes_on_redacted_output(self):
        assert_redacted(redact(payload_with_leaderboard()))

    def test_guard_accepts_a_genuinely_empty_prompt(self):
        assert_redacted(redact(payload_with_leaderboard(prompt=None)))


class TestBuildSnapshot:
    def test_redacts_by_default(self):
        snapshot = build_snapshot(FIXTURES)
        assert snapshot["snapshot"]["prompts_redacted"]

    def test_marks_itself_as_static(self):
        """The UI needs this to say it is not live."""
        assert build_snapshot(FIXTURES)["snapshot"]["static"]

    def test_carries_the_real_figures(self):
        snapshot = build_snapshot(FIXTURES)
        assert float(snapshot["overview"]["total_cost"]) > 0
        assert snapshot["cost_by_model"]

    def test_including_prompts_is_opt_in(self):
        snapshot = build_snapshot(FIXTURES, include_prompts=True)
        assert not snapshot["snapshot"]["prompts_redacted"]

    def test_output_is_json_serialisable(self):
        json.dumps(build_snapshot(FIXTURES))

    def test_contains_no_session_paths_or_prompt_text(self):
        """Whole-payload sweep, not just the fields redaction knows about."""
        blob = json.dumps(build_snapshot(FIXTURES))
        for probe in ("refactor the auth module", "now write the tests", ".jsonl"):
            assert probe not in blob


class TestCli:
    def test_writes_a_file_and_reports_it(self, tmp_path, capsys):
        out = tmp_path / "snapshot.json"
        assert main([str(out), "--path", str(FIXTURES)]) == 0
        assert out.exists()
        assert "redacted" in capsys.readouterr().out

    def test_warns_loudly_when_publishing_prompts(self, tmp_path, capsys):
        out = tmp_path / "snapshot.json"
        main([str(out), "--path", str(FIXTURES), "--include-prompts"])
        assert "WARNING" in capsys.readouterr().out

    def test_creates_missing_parent_directories(self, tmp_path):
        out = tmp_path / "nested" / "dir" / "snapshot.json"
        main([str(out), "--path", str(FIXTURES)])
        assert out.exists()

    def test_rejects_a_missing_log_directory(self, tmp_path):
        with pytest.raises(SystemExit):
            main([str(tmp_path / "o.json"), "--path", str(tmp_path / "nope")])
