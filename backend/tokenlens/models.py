"""Core data model.

Every ingestion source normalizes into these two types, so the scoring engine
never branches on where the data came from.

A `Call` is the unit of *billing* — one request to a model provider.
A `Turn` is the unit of *scoring* — one user prompt and every call it caused.

For single-shot logs (Helicone/OpenRouter exports, synthetic data) a Turn holds
exactly one Call. For agentic logs (Claude Code) a Turn holds however many calls
the agent loop made, which in practice ranges from 1 to 26.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class Profile(str, Enum):
    """Which shape the source data has.

    The distinction matters because prompt bloat means different things in each:
    for SIMPLE it is an oversized prompt, for AGENTIC it is oversized context
    dragged through the cache on every call of the loop.
    """

    SIMPLE = "simple"
    AGENTIC = "agentic"


@dataclass(frozen=True, slots=True)
class Call:
    """One billable request to a model."""

    model: str
    timestamp: datetime
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read: int = 0
    cache_write_5m: int = 0
    cache_write_1h: int = 0

    @property
    def cache_write(self) -> int:
        return self.cache_write_5m + self.cache_write_1h

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read
            + self.cache_write
        )

    @property
    def billable_input_tokens(self) -> int:
        """Every token charged as input, however it was cached.

        Used by the overshoot component: the question "what would this have cost
        on a cheaper model" applies to all input, not just uncached input.
        """
        return self.input_tokens + self.cache_read + self.cache_write


@dataclass(slots=True)
class Turn:
    """One user prompt and the calls it caused."""

    turn_id: str
    profile: Profile
    timestamp: datetime
    calls: list[Call] = field(default_factory=list)
    prompt_text: str | None = None
    user_id: str | None = None
    session_id: str | None = None

    @property
    def call_count(self) -> int:
        return len(self.calls)

    @property
    def is_scorable(self) -> bool:
        """Whether this turn can be classified.

        Turns without prompt text still count toward spend totals but receive a
        partial score, flagged as such rather than silently dropped.
        """
        return bool(self.prompt_text and self.prompt_text.strip())

    @property
    def models_used(self) -> list[str]:
        """Distinct models in first-use order."""
        seen: dict[str, None] = {}
        for call in self.calls:
            seen.setdefault(call.model, None)
        return list(seen)

    def tokens(self, kind: str) -> int:
        """Sum one token category across all calls."""
        return sum(getattr(call, kind) for call in self.calls)
