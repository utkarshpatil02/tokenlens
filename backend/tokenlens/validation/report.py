"""Validation report.

Answers "how do you know it works" with figures rather than assertions.

Three comparisons matter, and reporting fewer of them overstates the result:

* Classifier against hand labels, per axis. The headline number.
* Classifier *before* escalation against the same labels. Escalation is only
  worth its cost if the figure improves, and claiming an improvement without the
  earlier number is unfalsifiable.
* A second labeller against the first, on a shared subset. This is the realistic
  ceiling. Complexity is a judgement call, so a classifier matching a single
  labeller 80% of the time means something different depending on whether two
  humans agree 95% or 80% of the time.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from tokenlens.classify.schema import Category, Classification, Complexity
from tokenlens.models import Turn
from tokenlens.validation.labels import LabelSet
from tokenlens.validation.metrics import Agreement, agreement, confusion_grid

# Ordered worst-to-best so weighted kappa can measure distance between them.
COMPLEXITY_ORDER = tuple(c.value for c in Complexity)


class SelfComparisonError(ValueError):
    """Raised when the 'predictions' are the hand labels themselves.

    Hand labels can stand in for classifier output so the pipeline runs for
    free. Comparing that stand-in against the labels it came from would report
    perfect agreement and prove nothing, so it is refused rather than reported.
    """


@dataclass(slots=True)
class ValidationReport:
    labelled: int
    compared: int
    category: Agreement
    complexity: Agreement
    category_before: Agreement
    complexity_before: Agreement
    escalated: int
    escalation_changed_tier: int
    human: dict[str, Agreement] | None = None
    human_subset: int = 0
    examples: dict[tuple[str, str], list[str]] | None = None

    @property
    def complexity_kappa_delta(self) -> float:
        """Change in weighted kappa attributable to escalation."""
        return self.complexity.kappa - self.complexity_before.kappa

    def as_dict(self) -> dict:
        return {
            "labelled_prompts": self.labelled,
            "compared_prompts": self.compared,
            "after_escalation": {
                "category": self.category.as_dict(),
                "complexity": self.complexity.as_dict(),
            },
            "before_escalation": {
                "category": self.category_before.as_dict(),
                "complexity": self.complexity_before.as_dict(),
            },
            "escalation": {
                "escalated": self.escalated,
                "changed_required_tier": self.escalation_changed_tier,
                "complexity_kappa_before": round(self.complexity_before.kappa, 4),
                "complexity_kappa_after": round(self.complexity.kappa, 4),
                "complexity_kappa_delta": round(self.complexity_kappa_delta, 4),
            },
            "human_baseline": (
                {
                    "subset_size": self.human_subset,
                    "category": self.human["category"].as_dict(),
                    "complexity": self.human["complexity"].as_dict(),
                }
                if self.human
                else None
            ),
        }


def build_report(
    turns: list[Turn],
    classifications: dict[str, Classification],
    labels: LabelSet,
    second_labels: LabelSet | None = None,
) -> ValidationReport:
    """Compare hand labels against classifier output.

    Only turns present in both the label set and the classifications are
    compared; a prompt labelled but never classified proves nothing either way.
    """
    by_id = {t.turn_id: t for t in turns}
    turn_ids = sorted(set(labels.turn_ids) & set(classifications))

    human_sourced = [i for i in turn_ids if classifications[i].is_human]
    if human_sourced and len(human_sourced) == len(turn_ids):
        raise SelfComparisonError(
            "the classifications supplied are hand labels, not predictions, so "
            "comparing them against the label set would report perfect agreement "
            "and measure nothing. Run the classifier "
            "(python -m tokenlens.classify_cli) to produce predictions to validate."
        )

    ref_category: list[str] = []
    ref_complexity: list[str] = []
    got_category: list[str] = []
    got_complexity: list[str] = []
    before_category: list[str] = []
    before_complexity: list[str] = []
    examples: dict[tuple[str, str], list[str]] = {}

    escalated = 0
    changed = 0

    for turn_id in turn_ids:
        label = labels.labels[turn_id]
        found = classifications[turn_id]

        ref_category.append(label.category.value)
        ref_complexity.append(label.complexity.value)
        got_category.append(found.category.value)
        got_complexity.append(found.complexity.value)

        # For an escalated turn the base fields hold the first model's answer;
        # for the rest, the single answer is also the pre-escalation one.
        before_category.append(
            (found.base_category or found.category).value
        )
        before_complexity.append(
            (found.base_complexity or found.complexity).value
        )

        if found.escalated:
            escalated += 1
            if found.complexity_changed_on_escalation:
                changed += 1

        if label.complexity is not found.complexity:
            key = (label.complexity.value, found.complexity.value)
            prompt = by_id[turn_id].prompt_text if turn_id in by_id else None
            if prompt:
                examples.setdefault(key, []).append(" ".join(prompt.split())[:110])

    human = None
    human_subset = 0
    if second_labels is not None:
        shared = labels.overlap(second_labels)
        human_subset = len(shared)
        human = {
            "category": agreement(
                [labels.labels[i].category.value for i in shared],
                [second_labels.labels[i].category.value for i in shared],
                axis="category (human vs human)",
            ),
            "complexity": agreement(
                [labels.labels[i].complexity.value for i in shared],
                [second_labels.labels[i].complexity.value for i in shared],
                axis="complexity (human vs human)",
                ordinal=COMPLEXITY_ORDER,
            ),
        }

    return ValidationReport(
        labelled=len(labels),
        compared=len(turn_ids),
        category=agreement(ref_category, got_category, axis="category"),
        complexity=agreement(
            ref_complexity, got_complexity, axis="complexity", ordinal=COMPLEXITY_ORDER
        ),
        category_before=agreement(
            ref_category, before_category, axis="category (pre-escalation)"
        ),
        complexity_before=agreement(
            ref_complexity,
            before_complexity,
            axis="complexity (pre-escalation)",
            ordinal=COMPLEXITY_ORDER,
        ),
        escalated=escalated,
        escalation_changed_tier=changed,
        human=human,
        human_subset=human_subset,
        examples=examples,
    )


def format_report(report: ValidationReport) -> str:
    """Render the report for a terminal."""
    out: list[str] = []

    def line(text: str = "") -> None:
        out.append(text)

    line("TokenLens - classifier validation")
    line(f"{report.labelled} prompts labelled, {report.compared} compared")
    line()

    if not report.compared:
        line("Nothing to compare: no labelled prompt has been classified yet.")
        return "\n".join(out)

    line("Agreement with hand labels")
    line(f"  {'axis':<14} {'n':>4} {'raw':>7} {'kappa':>7}   interpretation")
    for result in (report.category, report.complexity):
        weighted = " (weighted)" if result.weighted else ""
        line(
            f"  {result.axis:<14} {result.n:>4} {result.observed:>6.1%} "
            f"{result.kappa:>7.3f}   {result.strength.value}{weighted}"
        )
    line()
    line("  Raw agreement is shown for continuity with other reports, but kappa is")
    line("  the figure that matters: on a skewed label mix, always answering the")
    line("  most common class scores well on raw agreement while learning nothing.")
    line()

    line("Effect of confidence-gated escalation")
    line(
        f"  {report.escalated} of {report.compared} prompts escalated; "
        f"{report.escalation_changed_tier} changed the required tier"
    )
    line(
        f"  complexity kappa {report.complexity_before.kappa:.3f} -> "
        f"{report.complexity.kappa:.3f} "
        f"({report.complexity_kappa_delta:+.3f})"
    )
    if report.escalated == 0:
        line("  No prompt fell below the confidence threshold, so escalation is untested.")
    line()

    if report.human:
        line(f"Human-to-human baseline ({report.human_subset} shared prompts)")
        for result in report.human.values():
            line(
                f"  {result.axis:<30} {result.observed:>6.1%} "
                f"kappa {result.kappa:>6.3f}  {result.strength.value}"
            )
        line("  This is the realistic ceiling, not 100%.")
    else:
        line("Human-to-human baseline: not collected")
        line("  Without it, a classifier figure has no ceiling to be read against.")
    line()

    line("Complexity confusion matrix")
    for row in confusion_grid(report.complexity):
        line("  " + "".join(cell.rjust(11) for cell in row))
    line()

    if report.examples:
        line("Where complexity disagreed (raw material for named failure modes)")
        ranked = sorted(report.examples.items(), key=lambda kv: len(kv[1]), reverse=True)
        for (expected, predicted), prompts in ranked[:4]:
            line(f"  labelled {expected}, classified {predicted} ({len(prompts)}x)")
            for prompt in prompts[:2]:
                line(f"      {prompt!r}")
        line()

    line("Score invariants: enforced as tests, not re-derived here")
    line("  - a cheaper model than required never scores as waste")
    line("  - a bloated prompt on a correct model still scores as waste")
    line("  - overshoot and bloat are disjoint and sum to actual minus ideal")
    line("  see backend/tests/test_scoring.py")

    return "\n".join(out)
