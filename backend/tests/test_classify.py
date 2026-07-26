"""Classifier and cache tests.

A fake client stands in for the API throughout: the test suite must never spend
money, and escalation behaviour is far easier to assert against scripted
confidences than against a live model.
"""

from datetime import datetime, timezone
from pathlib import Path

import pytest

from tokenlens.classify import (
    PROMPT_VERSION,
    Category,
    Classification,
    ClassificationCache,
    ClassificationError,
    ClassificationResponse,
    Classifier,
    Complexity,
    cache_key,
    required_tier,
)
from tokenlens.models import Call, Profile, Turn


class FakeResponse:
    def __init__(self, parsed):
        self.parsed_output = parsed
        self.stop_reason = "end_turn"


class FakeMessages:
    def __init__(self, script):
        self._script = script
        self.calls: list[dict] = []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        model = kwargs["model"]
        result = self._script.get(model)
        if callable(result):
            result = result(kwargs)
        return FakeResponse(result)


class FakeClient:
    """Returns a scripted classification per model."""

    def __init__(self, **script):
        self.messages = FakeMessages(script)


def response(
    category=Category.CODING,
    complexity=Complexity.MODERATE,
    confidence=0.9,
    rationale="because",
) -> ClassificationResponse:
    return ClassificationResponse(
        category=category, complexity=complexity, confidence=confidence, rationale=rationale
    )


def make_classifier(**script) -> Classifier:
    models = {"claude-haiku-4-5": None, "claude-sonnet-5": None} | script
    return Classifier(client=FakeClient(**models), cache=ClassificationCache())


def turn(turn_id="t1", prompt="do a thing") -> Turn:
    return Turn(
        turn_id=turn_id,
        profile=Profile.AGENTIC,
        timestamp=datetime(2026, 7, 20, tzinfo=timezone.utc),
        calls=[Call("claude-opus-5", datetime(2026, 7, 20, tzinfo=timezone.utc), output_tokens=5)],
        prompt_text=prompt,
    )


class TestConfidentPath:
    def test_high_confidence_answer_is_used_directly(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.95)})
        result = clf.classify("write a for loop")
        assert result.model == "claude-haiku-4-5"
        assert not result.escalated

    def test_confident_path_does_not_call_the_stronger_model(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.95)})
        clf.classify("write a for loop")
        models = [c["model"] for c in clf.client.messages.calls]
        assert models == ["claude-haiku-4-5"]

    def test_confidence_exactly_at_threshold_does_not_escalate(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.7)})
        assert not clf.classify("borderline").escalated


class TestEscalation:
    """Escalation exists to protect the tier-driving axis."""

    def test_low_confidence_triggers_a_second_opinion(self):
        clf = make_classifier(
            **{
                "claude-haiku-4-5": response(complexity=Complexity.TRIVIAL, confidence=0.3),
                "claude-sonnet-5": response(complexity=Complexity.COMPLEX, confidence=0.9),
            }
        )
        result = clf.classify("ambiguous prompt")
        assert result.escalated
        assert result.model == "claude-sonnet-5"

    def test_stronger_models_answer_wins(self):
        clf = make_classifier(
            **{
                "claude-haiku-4-5": response(complexity=Complexity.TRIVIAL, confidence=0.2),
                "claude-sonnet-5": response(complexity=Complexity.COMPLEX, confidence=0.88),
            }
        )
        result = clf.classify("ambiguous prompt")
        assert result.complexity is Complexity.COMPLEX
        assert result.confidence == 0.88

    def test_pre_escalation_answer_is_retained_for_validation(self):
        """Reporting agreement before and after escalation needs both answers."""
        clf = make_classifier(
            **{
                "claude-haiku-4-5": response(
                    category=Category.RESEARCH, complexity=Complexity.TRIVIAL, confidence=0.25
                ),
                "claude-sonnet-5": response(
                    category=Category.CODING, complexity=Complexity.COMPLEX, confidence=0.9
                ),
            }
        )
        result = clf.classify("ambiguous prompt")
        assert result.base_complexity is Complexity.TRIVIAL
        assert result.base_category is Category.RESEARCH
        assert result.base_confidence == 0.25

    def test_reports_when_escalation_changed_the_tier(self):
        clf = make_classifier(
            **{
                "claude-haiku-4-5": response(complexity=Complexity.TRIVIAL, confidence=0.2),
                "claude-sonnet-5": response(complexity=Complexity.COMPLEX, confidence=0.9),
            }
        )
        assert clf.classify("x").complexity_changed_on_escalation

    def test_escalation_that_confirms_is_not_a_tier_change(self):
        clf = make_classifier(
            **{
                "claude-haiku-4-5": response(complexity=Complexity.MODERATE, confidence=0.2),
                "claude-sonnet-5": response(complexity=Complexity.MODERATE, confidence=0.9),
            }
        )
        result = clf.classify("x")
        assert result.escalated
        assert not result.complexity_changed_on_escalation

    def test_threshold_is_configurable(self):
        client = FakeClient(
            **{
                "claude-haiku-4-5": response(confidence=0.5),
                "claude-sonnet-5": response(confidence=0.9),
            }
        )
        strict = Classifier(client=client, cache=ClassificationCache(), threshold=0.9)
        assert strict.classify("x").escalated


class TestCaching:
    """Classification is the only step that costs money."""

    def test_repeat_prompt_is_not_re_sent(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify("same prompt")
        clf.classify("same prompt")
        assert len(clf.client.messages.calls) == 1

    def test_cached_result_matches_the_original(self):
        clf = make_classifier(
            **{"claude-haiku-4-5": response(complexity=Complexity.COMPLEX, confidence=0.91)}
        )
        first = clf.classify("same prompt")
        assert clf.classify("same prompt") == first

    def test_escalated_results_are_cached_whole(self):
        clf = make_classifier(
            **{
                "claude-haiku-4-5": response(confidence=0.1),
                "claude-sonnet-5": response(confidence=0.9),
            }
        )
        clf.classify("hard one")
        clf.classify("hard one")
        assert len(clf.client.messages.calls) == 2  # not four

    def test_different_prompts_are_cached_separately(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify("prompt one")
        clf.classify("prompt two")
        assert len(clf.client.messages.calls) == 2

    def test_cache_can_be_bypassed(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify("p")
        clf.classify("p", use_cache=False)
        assert len(clf.client.messages.calls) == 2

    def test_survives_reopening_the_database(self, tmp_path):
        path = tmp_path / "cache.db"
        with ClassificationCache(path) as cache:
            first = Classifier(
                client=FakeClient(**{"claude-haiku-4-5": response(confidence=0.9)}),
                cache=cache,
            )
            first.classify("persistent prompt")

        with ClassificationCache(path) as cache:
            second = Classifier(
                client=FakeClient(**{"claude-haiku-4-5": response(confidence=0.9)}),
                cache=cache,
            )
            second.classify("persistent prompt")
            assert len(second.client.messages.calls) == 0


class TestCacheKeying:
    def test_prompt_version_is_part_of_the_key(self):
        """Editing the instructions changes the question being asked."""
        assert cache_key("p", "v1", "m") != cache_key("p", "v2", "m")

    def test_pipeline_configuration_is_part_of_the_key(self):
        assert cache_key("p", PROMPT_VERSION, "a->b@0.7") != cache_key(
            "p", PROMPT_VERSION, "a->b@0.9"
        )

    def test_changing_threshold_invalidates_cached_answers(self):
        cache = ClassificationCache()
        script = {
            "claude-haiku-4-5": response(confidence=0.5),
            "claude-sonnet-5": response(confidence=0.95),
        }
        lenient = Classifier(client=FakeClient(**script), cache=cache, threshold=0.4)
        strict = Classifier(client=FakeClient(**script), cache=cache, threshold=0.9)

        assert not lenient.classify("p").escalated
        assert strict.classify("p").escalated

    def test_identical_prompts_share_a_key(self):
        assert cache_key("p", "v", "m") == cache_key("p", "v", "m")


class TestPromptConstruction:
    def test_prompt_text_reaches_the_model(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify("refactor the parser")
        assert "refactor the parser" in clf.client.messages.calls[0]["messages"][0]["content"]

    def test_oversized_prompts_are_truncated(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify("x" * 50_000)
        sent = clf.client.messages.calls[0]["messages"][0]["content"]
        assert "truncated for classification" in sent
        assert len(sent) < 10_000

    def test_effort_is_not_sent(self):
        """Haiku 4.5 rejects the effort parameter."""
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify("p")
        assert "effort" not in clf.client.messages.calls[0]

    def test_schema_is_enforced_by_the_request(self):
        """`output_format` takes the model class; `output_config` would need a
        raw JSON-schema dict and rejects a class."""
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify("p")
        sent = clf.client.messages.calls[0]
        assert sent["output_format"] is ClassificationResponse
        assert "output_config" not in sent

    def test_request_matches_the_installed_sdk_signature(self):
        """Guards against drift between what we send and what parse() accepts."""
        import inspect

        from anthropic.resources.messages import Messages

        accepted = set(inspect.signature(Messages.parse).parameters)
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify("p")
        assert set(clf.client.messages.calls[0]) <= accepted


class TestFailureHandling:
    def test_unparseable_response_raises_rather_than_guessing(self):
        clf = make_classifier(**{"claude-haiku-4-5": None})
        with pytest.raises(ClassificationError, match="claude-haiku-4-5"):
            clf.classify("p")

    def test_constructing_a_classifier_needs_no_credentials(self):
        """Cached results must be readable without an API key present."""
        Classifier(cache=ClassificationCache())


class TestTurnClassification:
    def test_scorable_turns_are_classified(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        results = clf.classify_turns([turn("t1"), turn("t2", "another")])
        assert set(results) == {"t1", "t2"}

    def test_turns_without_prompt_text_are_skipped_not_guessed(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        blank = turn("t3")
        blank.prompt_text = None
        assert clf.classify_turns([blank]) == {}

    def test_repeated_prompt_across_turns_costs_one_call(self):
        clf = make_classifier(**{"claude-haiku-4-5": response(confidence=0.9)})
        clf.classify_turns([turn("t1", "same"), turn("t2", "same")])
        assert len(clf.client.messages.calls) == 1


class TestSchema:
    def test_complexity_maps_to_required_tier(self):
        assert required_tier(Complexity.TRIVIAL) == 1
        assert required_tier(Complexity.MODERATE) == 2
        assert required_tier(Complexity.COMPLEX) == 3

    def test_busywork_is_flagged_as_zero_value(self):
        result = Classification(
            category=Category.BUSYWORK,
            complexity=Complexity.TRIVIAL,
            confidence=0.9,
            rationale="r",
            model="m",
        )
        assert result.is_zero_value

    def test_non_busywork_is_not_zero_value(self):
        result = Classification(
            category=Category.CODING,
            complexity=Complexity.TRIVIAL,
            confidence=0.9,
            rationale="r",
            model="m",
        )
        assert not result.is_zero_value

    def test_category_does_not_determine_required_tier(self):
        """The v1 design error this schema exists to prevent."""
        coding_trivial = Classification(
            category=Category.CODING,
            complexity=Complexity.TRIVIAL,
            confidence=1.0,
            rationale="r",
            model="m",
        )
        research_complex = Classification(
            category=Category.RESEARCH,
            complexity=Complexity.COMPLEX,
            confidence=1.0,
            rationale="r",
            model="m",
        )
        assert coding_trivial.required_tier == 1
        assert research_complex.required_tier == 3

    def test_confidence_outside_zero_to_one_is_rejected(self):
        with pytest.raises(ValueError):
            ClassificationResponse(
                category=Category.CODING,
                complexity=Complexity.TRIVIAL,
                confidence=1.5,
                rationale="r",
            )

    def test_unknown_category_is_rejected(self):
        with pytest.raises(ValueError):
            ClassificationResponse(
                category="archaeology",
                complexity=Complexity.TRIVIAL,
                confidence=0.5,
                rationale="r",
            )
