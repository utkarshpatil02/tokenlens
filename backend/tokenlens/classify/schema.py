"""Classification schema.

Category and complexity are deliberately separate axes. Category is for
reporting and segmentation only; it does **not** determine which model a task
needed. An earlier design mapped category straight to a required tier, which was
wrong twice over: coding is among the most defensible uses of a frontier model,
so recommending a downgrade there is bad advice, and category does not imply
difficulty — "write a function to parse JSON" and "refactor this 2,000-line
module without changing behaviour" are both coding and need different models.

Complexity is the axis the Waste Score actually needs, so it is the one the
classifier reports confidence for and the one escalation exists to protect.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from pydantic import BaseModel, Field


class Category(str, Enum):
    """What the prompt is for. Reporting only — never drives required tier."""

    CODING = "coding"
    RESEARCH = "research"
    WRITING = "writing"
    SUMMARIZATION = "summarization"
    BUSYWORK = "busywork"


class Complexity(str, Enum):
    """How hard the task is. Drives the required model tier."""

    TRIVIAL = "trivial"
    MODERATE = "moderate"
    COMPLEX = "complex"


REQUIRED_TIER: dict[Complexity, int] = {
    Complexity.TRIVIAL: 1,
    Complexity.MODERATE: 2,
    Complexity.COMPLEX: 3,
}

# Hand labels can stand in for classifier output so the pipeline runs without
# spending anything. They carry this prefix in `model` so nothing downstream
# mistakes a human judgement for a prediction — validation in particular must
# refuse to score labels against themselves, which would report perfect
# agreement and mean nothing at all.
HUMAN_MODEL_PREFIX = "human:"


def required_tier(complexity: Complexity) -> int:
    return REQUIRED_TIER[complexity]


class ClassificationResponse(BaseModel):
    """The shape the model is constrained to return."""

    category: Category
    complexity: Complexity
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="Certainty about the complexity call specifically, 0 to 1.",
    )
    rationale: str = Field(
        description="One sentence explaining the complexity call.",
    )


@dataclass(frozen=True, slots=True)
class Classification:
    """A finished classification, carrying its own provenance.

    The pre-escalation values are retained alongside the final ones so
    validation can report agreement both before and after escalation. An
    improving figure is a stronger result than a flat one, but only if the
    earlier answer was kept.
    """

    category: Category
    complexity: Complexity
    confidence: float
    rationale: str
    model: str
    escalated: bool = False
    base_category: Category | None = None
    base_complexity: Complexity | None = None
    base_confidence: float | None = None

    @property
    def required_tier(self) -> int:
        return required_tier(self.complexity)

    @property
    def is_zero_value(self) -> bool:
        """Busywork: a task where LLM use is not justified at any tier."""
        return self.category is Category.BUSYWORK

    @property
    def is_human(self) -> bool:
        """Whether this is a hand label standing in for a prediction."""
        return self.model.startswith(HUMAN_MODEL_PREFIX)

    @property
    def complexity_changed_on_escalation(self) -> bool:
        """Whether escalation actually altered the tier-driving axis."""
        return (
            self.escalated
            and self.base_complexity is not None
            and self.base_complexity is not self.complexity
        )
