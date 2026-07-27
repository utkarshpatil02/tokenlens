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

from tokenlens.classify.schema import Category, Complexity
from tokenlens.models import Turn

FIELDS = ("turn_id", "prompt", "category", "complexity", "notes")

_CATEGORIES = tuple(c.value for c in Category)
_COMPLEXITIES = tuple(c.value for c in Complexity)


class LabelError(ValueError):
    """Raised on an unusable label file, naming the row and the problem."""


@dataclass(slots=True)
class Label:
    turn_id: str
    category: Category
    complexity: Complexity
    notes: str = ""


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

    def overlap(self, other: LabelSet) -> list[str]:
        """Turn ids both label, in a stable order for aligned comparison."""
        return sorted(self.turn_ids & other.turn_ids)

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

                labels[turn_id] = Label(
                    turn_id=turn_id,
                    category=Category(category),
                    complexity=Complexity(complexity),
                    notes=(row.get("notes") or "").strip(),
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
                    "notes": "",
                }
            )
    return len(scorable)
