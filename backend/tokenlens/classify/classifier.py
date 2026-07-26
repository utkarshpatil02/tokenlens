"""Prompt classifier with confidence-gated escalation.

Haiku classifies every prompt. When it reports low confidence on the complexity
call, the prompt is re-sent to Sonnet for a second opinion and Sonnet's answer is
used. Escalation is rare by construction — most prompts are unambiguous — so it
stays cheap while targeting the error that matters most: complexity drives the
required tier, and therefore the largest term in the Waste Score.

Using the cheapest model that does the job, and paying for a stronger one only
where it changes the answer, is the project's own thesis applied to itself.
"""

from __future__ import annotations

from collections.abc import Iterable

from tokenlens.classify.cache import ClassificationCache, cache_key
from tokenlens.classify.schema import Classification, ClassificationResponse
from tokenlens.models import Turn

# Bump when the instructions below change. It is part of the cache key, so old
# answers are never served for a differently-worded question.
PROMPT_VERSION = "2026-07-26.1"

BASE_MODEL = "claude-haiku-4-5"
ESCALATION_MODEL = "claude-sonnet-5"

# Below this confidence on the complexity call, get a second opinion.
DEFAULT_THRESHOLD = 0.7

# Classification signal lives in the opening of a prompt; a pasted 50k-token
# file does not make the task harder to categorise, only more expensive to read.
MAX_PROMPT_CHARS = 6_000

SYSTEM_PROMPT = """\
You classify prompts that were sent to AI models, so their cost can be analysed.

Return two independent judgements plus your confidence.

CATEGORY — what the task is. Used for reporting only. It must NOT influence \
your complexity judgement.
  coding         writing, debugging, reviewing, or explaining code
  research       finding, gathering, comparing, or investigating information
  writing        composing prose, documentation, messages, or creative text
  summarization  condensing or extracting from text the user supplied
  busywork       trivial lookups or chores where using an AI model at all is \
not justified (checking the weather, simple arithmetic, a definition)

COMPLEXITY — how hard the task is. This is the judgement that matters.
  trivial   single step, no reasoning, no context integration
  moderate  multiple steps, or requires synthesising context the user provided
  complex   extended reasoning, long context, or high stakes for being wrong

Judge complexity by the work required, not by the topic or how the prompt is \
phrased. A short question can be complex and a long one trivial. Do not assume \
coding is hard or that writing is easy.

CONFIDENCE — how certain you are about COMPLEXITY specifically, from 0 to 1. \
Be honest: report low confidence when the prompt is ambiguous, underspecified, \
or could reasonably be read at two different levels. Low confidence is useful \
information, not a failure.

RATIONALE — one sentence justifying the complexity call.\
"""

USER_TEMPLATE = """\
Classify this prompt:

<prompt>
{prompt}
</prompt>"""


class Classifier:
    """Classifies prompts, escalating ambiguous ones to a stronger model."""

    def __init__(
        self,
        client=None,
        cache: ClassificationCache | None = None,
        threshold: float = DEFAULT_THRESHOLD,
        base_model: str = BASE_MODEL,
        escalation_model: str = ESCALATION_MODEL,
    ):
        self._client = client
        self.cache = cache if cache is not None else ClassificationCache()
        self.threshold = threshold
        self.base_model = base_model
        self.escalation_model = escalation_model

    @property
    def client(self):
        """The Anthropic client, created on first use.

        Deferred so that constructing a Classifier never requires credentials —
        cached results can be read without an API key present.
        """
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic()
        return self._client

    @property
    def pipeline_id(self) -> str:
        """Identity of this configuration, for cache keying.

        Changing either model or the threshold changes the answer, so results
        from a different configuration must not be reused.
        """
        return f"{self.base_model}->{self.escalation_model}@{self.threshold}"

    def classify(self, prompt_text: str, *, use_cache: bool = True) -> Classification:
        key = cache_key(prompt_text, PROMPT_VERSION, self.pipeline_id)
        if use_cache:
            cached = self.cache.get(key)
            if cached is not None:
                return cached

        base = self._ask(self.base_model, prompt_text)

        if base.confidence >= self.threshold:
            result = Classification(
                category=base.category,
                complexity=base.complexity,
                confidence=base.confidence,
                rationale=base.rationale,
                model=self.base_model,
            )
        else:
            escalated = self._ask(self.escalation_model, prompt_text)
            result = Classification(
                category=escalated.category,
                complexity=escalated.complexity,
                confidence=escalated.confidence,
                rationale=escalated.rationale,
                model=self.escalation_model,
                escalated=True,
                base_category=base.category,
                base_complexity=base.complexity,
                base_confidence=base.confidence,
            )

        self.cache.put(key, prompt_text, PROMPT_VERSION, result)
        return result

    def classify_turns(
        self, turns: Iterable[Turn], *, use_cache: bool = True
    ) -> dict[str, Classification]:
        """Classify every scorable turn, keyed by turn id.

        Turns without prompt text are skipped rather than guessed at; they still
        count toward spend, and are reported as partially scored.
        """
        results: dict[str, Classification] = {}
        for turn in turns:
            if not turn.is_scorable:
                continue
            results[turn.turn_id] = self.classify(turn.prompt_text, use_cache=use_cache)
        return results

    def _ask(self, model: str, prompt_text: str) -> ClassificationResponse:
        # `output_format` takes the Pydantic class and validates the reply into
        # it. The lower-level `output_config` expects a raw JSON-schema dict
        # instead, so passing a model class there fails at request time.
        response = self.client.messages.parse(
            model=model,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": _render(prompt_text)}],
            output_format=ClassificationResponse,
        )
        parsed = response.parsed_output
        if parsed is None:
            raise ClassificationError(
                f"{model} returned no parseable classification "
                f"(stop_reason={getattr(response, 'stop_reason', None)!r})"
            )
        return parsed


class ClassificationError(RuntimeError):
    """Raised when a model returns nothing usable."""


def _render(prompt_text: str) -> str:
    text = prompt_text.strip()
    if len(text) > MAX_PROMPT_CHARS:
        text = text[:MAX_PROMPT_CHARS] + "\n[... truncated for classification ...]"
    return USER_TEMPLATE.format(prompt=text)
