"""Hand-labelled reference set.

Labels are held in CSV so they can be filled in a spreadsheet and reviewed in a
diff. The export writes prompts with the label columns blank, which matters
methodologically: labelling has to happen before the classifier's answers are
visible, or the reference set is anchored to the thing it is meant to evaluate.

A second labeller uses the same export. Human-to-human agreement on a shared
subset is the realistic ceiling — reporting classifier agreement without it
implies the task has one obvious answer, and on complexity it does not.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path

from pathlib import Path as _Path

from tokenlens.classify.schema import (
    HUMAN_MODEL_PREFIX,
    Category,
    Classification,
    Complexity,
)
from tokenlens.models import Turn

FIELDS = ("turn_id", "prompt", "category", "complexity", "context_dependent", "notes")

_CATEGORIES = tuple(c.value for c in Category)
_COMPLEXITIES = tuple(c.value for c in Complexity)

_TRUE = {"y", "yes", "true", "1"}
_FALSE = {"", "n", "no", "false", "0"}


class LabelError(ValueError):
    """Raised on an unusable label file, naming the row and the problem."""


@dataclass(slots=True)
class Label:
    turn_id: str
    category: Category
    complexity: Complexity
    notes: str = ""
    context_dependent: bool = False
    """This label rests on something the classifier is never shown.

    The classifier sees one prompt and nothing else. Where the labeller drew on
    what the turn actually went on to do, agreement measures a distinction the
    classifier had no way to draw, and kappa is charged for it. Marking the row
    does not drop it — `build_report` reports the figure both ways, because
    which one is the honest headline is a judgement, not a default.
    """


@dataclass(slots=True)
class LabelSet:
    """Hand labels, keyed by turn id."""

    labels: dict[str, Label] = field(default_factory=dict)
    source: str = ""

    def __len__(self) -> int:
        return len(self.labels)

    def __contains__(self, turn_id: object) -> bool:
        return turn_id in self.labels

    def get(self, turn_id: str) -> Label | None:
        return self.labels.get(turn_id)

    @property
    def turn_ids(self) -> set[str]:
        return set(self.labels)

    @property
    def context_dependent_ids(self) -> set[str]:
        """Turn ids whose label draws on more than the prompt text."""
        return {i for i, label in self.labels.items() if label.context_dependent}

    def overlap(self, other: LabelSet) -> list[str]:
        """Turn ids both label, in a stable order for aligned comparison."""
        return sorted(self.turn_ids & other.turn_ids)

    def to_classifications(self) -> dict[str, Classification]:
        """Use hand labels where classifier output would go.

        This is the free path: scoring, the heatmap, and the leaderboard all
        work from labels alone, so the pipeline runs end to end without spending
        anything. It is not a degraded mode — for the turns covered, a human
        judgement is a better input than a prediction.

        What it cannot do is measure the classifier, since there is no
        prediction to compare against. Each result is stamped with a
        `human:` model so that validation refuses to score labels against
        themselves rather than reporting a meaningless perfect agreement.

        Confidence is 1.0 because these are the reference labels, not a
        prediction carrying uncertainty.
        """
        source = _Path(self.source).name if self.source else "labels"
        return {
            turn_id: Classification(
                category=label.category,
                complexity=label.complexity,
                confidence=1.0,
                rationale=label.notes or "hand-labelled",
                model=f"{HUMAN_MODEL_PREFIX}{source}",
            )
            for turn_id, label in self.labels.items()
        }

    @classmethod
    def load(cls, path: Path | str) -> LabelSet:
        path = Path(path)
        labels: dict[str, Label] = {}

        with open(path, encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            missing = {"turn_id", "category", "complexity"} - set(reader.fieldnames or ())
            if missing:
                raise LabelError(
                    f"{path.name} is missing required column(s): {', '.join(sorted(missing))}"
                )

            for line, row in enumerate(reader, start=2):
                turn_id = (row.get("turn_id") or "").strip()
                category = (row.get("category") or "").strip().lower()
                complexity = (row.get("complexity") or "").strip().lower()

                if not turn_id:
                    continue
                # An unfilled row is work not yet done, not an error.
                if not category and not complexity:
                    continue
                if not category or not complexity:
                    raise LabelError(
                        f"{path.name} line {line}: both category and complexity are "
                        f"required once a row is labelled (got "
                        f"category={category!r}, complexity={complexity!r})"
                    )
                if category not in _CATEGORIES:
                    raise LabelError(
                        f"{path.name} line {line}: unknown category {category!r}; "
                        f"expected one of {', '.join(_CATEGORIES)}"
                    )
                if complexity not in _COMPLEXITIES:
                    raise LabelError(
                        f"{path.name} line {line}: unknown complexity {complexity!r}; "
                        f"expected one of {', '.join(_COMPLEXITIES)}"
                    )
                if turn_id in labels:
                    raise LabelError(f"{path.name} line {line}: duplicate turn_id {turn_id!r}")

                # Optional column: a sheet written before it existed still loads,
                # and simply marks nothing.
                flag = (row.get("context_dependent") or "").strip().lower()
                if flag not in _TRUE and flag not in _FALSE:
                    raise LabelError(
                        f"{path.name} line {line}: context_dependent must be one of "
                        f"{', '.join(sorted(_TRUE))} or left blank (got {flag!r})"
                    )

                labels[turn_id] = Label(
                    turn_id=turn_id,
                    category=Category(category),
                    complexity=Complexity(complexity),
                    notes=(row.get("notes") or "").strip(),
                    context_dependent=flag in _TRUE,
                )

        return cls(labels=labels, source=str(path))


def export_template(
    turns: list[Turn], path: Path | str, limit: int | None = None
) -> int:
    """Write a blank labelling sheet. Returns how many rows were written.

    Label columns are left empty on purpose — see the module docstring.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    scorable = [t for t in turns if t.is_scorable]
    if limit is not None:
        scorable = scorable[:limit]

    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for turn in scorable:
            writer.writerow(
                {
                    "turn_id": turn.turn_id,
                    # Collapse newlines so one prompt stays one spreadsheet row.
                    "prompt": " ".join((turn.prompt_text or "").split()),
                    "category": "",
                    "complexity": "",
                    "context_dependent": "",
                    "notes": "",
                }
            )
    return len(scorable)
