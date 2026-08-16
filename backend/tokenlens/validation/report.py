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

Where a label was marked `context_dependent`, the figure is reported a second
time without those rows. The classifier is shown one prompt and nothing else, so
a label that rests on what the turn went on to do asks it for a distinction it
cannot see, and kappa charges it for the miss. Both numbers are printed and
neither is called the headline: quoting only the whole set understates the
classifier, quoting only the filtered set flatters it, and picking one silently
is the kind of choice this project reports rather than makes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
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
    context_dependent: int = 0
    category_excluding: Agreement | None = None
    complexity_excluding: Agreement | None = None
    context_prompts: list[str] = field(default_factory=list)

    @property
    def complexity_kappa_delta(self) -> float:
        """Change in weighted kappa attributable to escalation."""
        return self.complexity.kappa - self.complexity_before.kappa

    @property
    def context_kappa_delta(self) -> float | None:
        """How much the context-dependent rows moved the complexity kappa.

        Positive means they were holding the figure down — the classifier was
        being charged for distinctions the prompt text does not carry.
        """
        if self.complexity_excluding is None:
            return None
        return self.complexity_excluding.kappa - self.complexity.kappa

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
            "excluding_context_dependent": (
                {
                    "excluded": self.context_dependent,
                    "prompts": list(self.context_prompts),
                    "category": self.category_excluding.as_dict(),
                    "complexity": self.complexity_excluding.as_dict(),
                    "complexity_kappa_delta": round(self.context_kappa_delta or 0.0, 4),
                }
                if self.category_excluding and self.complexity_excluding
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
    # Parallel to the label lists: False where the row rests on context the
    # classifier never saw, so the second comparison can drop exactly those.
    keep: list[bool] = []
    context_prompts: list[str] = []

    escalated = 0
    changed = 0

    for turn_id in turn_ids:
        label = labels.labels[turn_id]
        found = classifications[turn_id]
        keep.append(not label.context_dependent)
        if label.context_dependent:
            prompt = by_id[turn_id].prompt_text if turn_id in by_id else None
            context_prompts.append(" ".join(prompt.split())[:110] if prompt else turn_id)

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

    # The same comparison with the context-dependent rows dropped. Computed only
    # when some were marked and some survive: "excluding nothing" is the figure
    # already reported, and an empty remainder measures nothing at all.
    category_excluding = None
    complexity_excluding = None
    if context_prompts and any(keep):
        def without(values: list[str]) -> list[str]:
            return [v for v, k in zip(values, keep) if k]

        category_excluding = agreement(
            without(ref_category),
            without(got_category),
            axis="category (excl.)",
        )
        complexity_excluding = agreement(
            without(ref_complexity),
            without(got_complexity),
            axis="complexity (excl.)",
            ordinal=COMPLEXITY_ORDER,
        )

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
        context_dependent=len(context_prompts),
        category_excluding=category_excluding,
        complexity_excluding=complexity_excluding,
        context_prompts=context_prompts,
    )


# Wide enough for the longest axis name, "complexity (excl.)", so the two
# agreement tables line up under one another rather than stepping sideways.
_AXIS = 18


def _row(result: Agreement) -> str:
    weighted = " (weighted)" if result.weighted else ""
    return (
        f"{result.axis:<{_AXIS}} {result.n:>4} {result.observed:>6.1%} "
        f"{result.kappa:>7.3f}   {result.strength.value}{weighted}"
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
    line(f"  {'axis':<{_AXIS}} {'n':>4} {'raw':>7} {'kappa':>7}   interpretation")
    for result in (report.category, report.complexity):
        line("  " + _row(result))
    line()
    line("  Raw agreement is shown for continuity with other reports, but kappa is")
    line("  the figure that matters: on a skewed label mix, always answering the")
    line("  most common class scores well on raw agreement while learning nothing.")
    line()

    if report.category_excluding and report.complexity_excluding:
        line(
            f"Excluding {report.context_dependent} context-dependent "
            f"{'label' if report.context_dependent == 1 else 'labels'}"
        )
        for result in (report.category_excluding, report.complexity_excluding):
            line("  " + _row(result))
        delta = report.context_kappa_delta or 0.0
        line(f"  complexity kappa moves {delta:+.3f} with these rows dropped")
        line()
        line("  These labels were marked as resting on what the turn went on to do.")
        line("  The classifier is shown the prompt and nothing else, so on these rows")
        line("  it is charged for a distinction it cannot see. Neither figure is the")
        line("  headline: quote both, or quote one and say which.")
        for prompt in report.context_prompts[:6]:
            line(f"      {prompt!r}")
        if len(report.context_prompts) > 6:
            line(f"      ... and {len(report.context_prompts) - 6} more")
        line()
    elif report.context_dependent:
        line(
            f"All {report.context_dependent} compared labels are marked "
            "context-dependent, so there is no remainder to compare."
        )
        line()
    else:
        line("Context-dependent labels: none marked")
        line("  Mark a row in the sheet where the label rests on what the turn did,")
        line("  not on what the prompt says, and the figure is reported both ways.")
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
