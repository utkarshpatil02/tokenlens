"""Claude Code ingestion tests.

The fixture encodes every shape found in real session logs: prompts as plain
strings and as text-block lists, tool-result records, harness-injected content
(both `isMeta`-flagged and XML-tagged), assistant records with and without a
usage block, an orphaned call whose parent is missing, a prompt that produced no
calls, a non-conversation record type, and a malformed line.
"""

from datetime import timezone
from decimal import Decimal
from pathlib import Path

import pytest

from tokenlens.ingest.claude_code import parse_projects, parse_session
from tokenlens.models import Profile
from tokenlens.pricing import default_table

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES / "sample_session.jsonl"
RESUMED = FIXTURES / "resumed_session.jsonl"


@pytest.fixture
def turns():
    return parse_session(FIXTURE)


@pytest.fixture
def by_prompt(turns):
    return {t.prompt_text: t for t in turns}


class TestTurnGrouping:
    """One prompt to many calls is the defining property of agentic data."""

    def test_calls_group_under_the_prompt_that_caused_them(self, by_prompt):
        # p1 has three billable calls: a1, a2 (via the tool-result record), a7.
        assert by_prompt["refactor the auth module"].call_count == 3

    def test_grouping_walks_through_tool_result_records(self, by_prompt):
        """A call whose parent is a tool result still belongs to the prompt."""
        turn = by_prompt["refactor the auth module"]
        assert 300 in [c.output_tokens for c in turn.calls]

    def test_separate_prompts_become_separate_turns(self, by_prompt):
        assert by_prompt["refactor the auth module"].turn_id != by_prompt["now write the tests"].turn_id

    def test_turn_id_is_namespaced_by_session(self, turns):
        assert all(t.turn_id.startswith("sess-abc:") for t in turns)

    def test_session_id_is_recorded(self, turns):
        assert all(t.session_id == "sess-abc" for t in turns)

    def test_turn_timestamp_is_earliest_call(self, by_prompt):
        """a7 runs at 10:00:03, before a1 at 10:00:05, despite appearing last."""
        turn = by_prompt["refactor the auth module"]
        assert turn.timestamp.astimezone(timezone.utc).second == 3

    def test_profile_is_agentic(self, turns):
        assert all(t.profile is Profile.AGENTIC for t in turns)


class TestSpendPreservation:
    """Total spend must survive ingestion; dropping calls is not an option."""

    def test_every_billable_call_is_kept(self, turns):
        # 9 assistant records carry a usage block (a3 has none). Three of those
        # nine are one response split across content blocks, so 7 API requests.
        assert sum(t.call_count for t in turns) == 7

    def test_orphaned_call_is_retained_not_dropped(self, turns):
        """A call whose parent is missing is still real money."""
        unattributed = [t for t in turns if "unattributed" in t.turn_id]
        assert len(unattributed) == 1
        assert unattributed[0].call_count == 1

    def test_orphaned_turn_has_no_prompt_text(self, turns):
        unattributed = next(t for t in turns if "unattributed" in t.turn_id)
        assert unattributed.prompt_text is None
        assert not unattributed.is_scorable

    def test_record_without_usage_block_is_not_billed(self, by_prompt):
        """a3 has content but no usage — not a billable call."""
        outputs = [c.output_tokens for c in by_prompt["refactor the auth module"].calls]
        assert sorted(outputs) == [55, 120, 300]

    def test_prompt_with_no_calls_produces_no_turn(self, by_prompt):
        assert "a prompt that produced no calls" not in by_prompt


class TestDeduplication:
    """Both duplication forms were found in real logs, not anticipated.

    Left unhandled they overstate spend by roughly 2x, which would have made
    every dollar figure the project reports wrong.
    """

    def test_response_split_across_blocks_bills_once(self, by_prompt):
        """Three records, one message.id, one usage object, one API request."""
        turn = by_prompt["one response split across content blocks"]
        assert turn.call_count == 1

    def test_split_response_is_not_triple_counted(self, by_prompt):
        turn = by_prompt["one response split across content blocks"]
        assert turn.tokens("output_tokens") == 1078
        assert turn.tokens("cache_read") == 89201

    def test_resumed_session_does_not_rebill_copied_history(self):
        """A resumed session inherits history; only its new work is new spend."""
        seen: set[str] = set()
        first = parse_session(FIXTURE, seen_message_ids=seen)
        resumed = parse_session(RESUMED, seen_message_ids=seen)

        resumed_prompts = {t.prompt_text for t in resumed}
        assert "genuinely new work in the resumed session" in resumed_prompts
        assert "one response split across content blocks" not in resumed_prompts
        assert sum(t.call_count for t in resumed) == 1
        assert sum(t.call_count for t in first) == 7

    def test_parse_projects_dedupes_across_files(self):
        """The shared-state path is what production actually calls."""
        calls = [c for t in parse_projects(FIXTURES) for c in t.calls]
        # 7 requests in the first session, plus the 1 genuinely new request in
        # the resumed one. Its copied history is not re-billed.
        assert len(calls) == 8

    def test_parsing_one_file_twice_in_isolation_is_unaffected(self):
        """Without shared state each file stands alone — no hidden coupling."""
        assert sum(t.call_count for t in parse_session(FIXTURE)) == sum(
            t.call_count for t in parse_session(FIXTURE)
        )

    def test_locally_fabricated_messages_are_not_billed(self, turns):
        """Claude Code writes `<synthetic>` records for interrupt markers and
        session-limit notices. No request was made, and the sentinel is not a
        real model id, so the pricer would rightly refuse it."""
        models = {c.model for t in turns for c in t.calls}
        assert not any(m.startswith("<") for m in models)

    def test_synthetic_record_does_not_consume_its_turn(self, by_prompt):
        """The turn it attaches to keeps only its genuine calls."""
        assert by_prompt["now write the tests"].call_count == 1

    def test_call_without_any_id_is_counted_rather_than_dropped(self, turns):
        """a6 has a requestId but the orphan path must still bill it."""
        unattributed = next(t for t in turns if "unattributed" in t.turn_id)
        assert unattributed.call_count == 1


class TestPromptExtraction:
    def test_string_content_is_extracted(self, by_prompt):
        assert "refactor the auth module" in by_prompt

    def test_text_block_list_is_extracted(self, by_prompt):
        assert "now write the tests" in by_prompt

    def test_meta_flagged_content_is_excluded(self, turns):
        assert not any("Base directory for this skill" in (t.prompt_text or "") for t in turns)

    def test_xml_tagged_injection_is_excluded(self, turns):
        """Slash-command wrappers are prompt-shaped but not prompts."""
        assert not any((t.prompt_text or "").startswith("<") for t in turns)

    def test_injected_prompt_still_keeps_its_spend(self, turns):
        """Filtering the text must not discard the call it triggered."""
        haiku_calls = [
            c for t in turns for c in t.calls if c.model == "claude-haiku-4-5" and c.output_tokens == 40
        ]
        assert len(haiku_calls) == 1

    def test_tool_result_records_are_not_treated_as_prompts(self, turns):
        assert not any("file contents" in (t.prompt_text or "") for t in turns)

    def test_scorable_turns_have_prompt_text(self, turns):
        for turn in turns:
            assert turn.is_scorable == bool(turn.prompt_text)


class TestCacheTTLExtraction:
    """Getting the TTL split wrong changes cache-write cost by 60%."""

    def test_1h_writes_are_read_from_cache_creation(self, by_prompt):
        turn = by_prompt["refactor the auth module"]
        assert turn.tokens("cache_write_1h") == 9500
        assert turn.tokens("cache_write_5m") == 0

    def test_5m_writes_are_read_separately(self, turns):
        """The haiku turn's 500 explicit 5m tokens, isolated from the 2000 that
        the legacy-aggregate turn contributes to the same tier."""
        haiku_turns = [t for t in turns if t.models_used == ["claude-haiku-4-5"]]
        explicit_5m = [t for t in haiku_turns if t.tokens("cache_write_5m")]
        assert [t.tokens("cache_write_5m") for t in explicit_5m] == [500]

    def test_legacy_aggregate_field_defaults_to_cheaper_tier(self, by_prompt):
        """An unknown TTL must never inflate the reported figure."""
        turn = by_prompt["now write the tests"]
        assert turn.tokens("cache_write_5m") == 2000
        assert turn.tokens("cache_write_1h") == 0

    def test_cache_read_is_extracted(self, by_prompt):
        assert by_prompt["refactor the auth module"].tokens("cache_read") == 52000


class TestRobustness:
    def test_malformed_line_does_not_abort_the_file(self, by_prompt):
        """The record after the bad line must still be parsed."""
        assert by_prompt["refactor the auth module"].call_count == 3

    def test_non_conversation_records_are_ignored(self, turns):
        assert all(t.prompt_text != "enqueue" for t in turns)

    def test_models_are_captured_per_call(self, by_prompt):
        assert by_prompt["now write the tests"].models_used == ["claude-opus-5"]

    def test_timestamps_are_timezone_aware(self, turns):
        assert all(c.timestamp.tzinfo is not None for t in turns for c in t.calls)


class TestCostIntegration:
    """Ingestion output must flow straight into the cost engine."""

    def test_parsed_turns_are_priceable(self, turns):
        table = default_table()
        total = sum(
            (table.cost_of(c) for t in turns for c in t.calls),
            Decimal(0),
        )
        assert total > Decimal(0)

    def test_cache_dominates_cost_as_in_real_data(self, turns):
        table = default_table()
        totals: dict[str, Decimal] = {}
        for turn in turns:
            for call in turn.calls:
                for category, cost in table.cost_breakdown(call).items():
                    totals[category] = totals.get(category, Decimal(0)) + cost
        cache = totals["cache_read"] + totals["cache_write_5m"] + totals["cache_write_1h"]
        assert cache > totals["input_tokens"]


class TestParseProjects:
    def test_walks_a_directory_tree(self):
        """Both fixture sessions are picked up, not just one."""
        sessions = {t.session_id for t in parse_projects(FIXTURES)}
        assert sessions == {"sess-abc", "sess-resumed"}

    def test_missing_directory_yields_nothing(self, tmp_path):
        assert parse_projects(tmp_path / "does-not-exist") == []

    def test_empty_directory_yields_nothing(self, tmp_path):
        assert parse_projects(tmp_path) == []
