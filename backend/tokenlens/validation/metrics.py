"""Agreement metrics.

Raw percent agreement is reported but never alone. On a skewed label
distribution it flatters badly: if 70% of prompts are `moderate`, a classifier
that answers `moderate` every time scores 70% while having learned nothing.
Cohen's kappa corrects for the agreement chance alone would produce, so it is the
figure that carries the claim.

Complexity is ordinal — trivial, moderate, complex — so confusing trivial with
complex is a worse error than confusing trivial with moderate. Unweighted kappa
treats those as equally wrong. Linearly weighted kappa is therefore used for
complexity, and unweighted for category, which is nominal (coding and writing are
different, not further apart than coding and research).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from enum import Enum


class Strength(str, Enum):
    """Landis & Koch bands, for reading a kappa figure honestly."""

    POOR = "poor"
    SLIGHT = "slight"
    FAIR = "fair"
    MODERATE = "moderate"
    SUBSTANTIAL = "substantial"
    ALMOST_PERFECT = "almost perfect"


def strength_of(kappa: float) -> Strength:
    if kappa < 0:
        return Strength.POOR
    if kappa <= 0.20:
        return Strength.SLIGHT
    if kappa <= 0.40:
        return Strength.FAIR
    if kappa <= 0.60:
        return Strength.MODERATE
    if kappa <= 0.80:
        return Strength.SUBSTANTIAL
    return Strength.ALMOST_PERFECT


@dataclass(slots=True)
class Agreement:
    """How two sets of labels compare on one axis."""

    axis: str
    n: int
    observed: float
    expected: float
    kappa: float
    weighted: bool
    confusion: dict[tuple[str, str], int] = field(default_factory=dict)
    labels: tuple[str, ...] = ()

    @property
    def strength(self) -> Strength:
        return strength_of(self.kappa)

    @property
    def disagreements(self) -> list[tuple[tuple[str, str], int]]:
        """Off-diagonal cells, worst first — where the classifier actually fails."""
        return sorted(
            ((pair, count) for pair, count in self.confusion.items() if pair[0] != pair[1]),
            key=lambda item: item[1],
            reverse=True,
        )

    def as_dict(self) -> dict:
        return {
            "axis": self.axis,
            "n": self.n,
            "observed_agreement": round(self.observed, 4),
            "expected_agreement": round(self.expected, 4),
            "kappa": round(self.kappa, 4),
            "weighted": self.weighted,
            "strength": self.strength.value,
            "labels": list(self.labels),
            "confusion": [
                {"reference": ref, "predicted": pred, "count": count}
                for (ref, pred), count in sorted(self.confusion.items())
            ],
            "top_disagreements": [
                {"reference": ref, "predicted": pred, "count": count}
                for (ref, pred), count in self.disagreements[:5]
            ],
        }


def agreement(
    reference: list[str],
    predicted: list[str],
    axis: str = "",
    ordinal: tuple[str, ...] | None = None,
) -> Agreement:
    """Compare two aligned label sequences.

    `ordinal` names the label order for a weighted comparison; omit it for a
    nominal axis, where every disagreement is equally wrong.
    """
    if len(reference) != len(predicted):
        raise ValueError(
            f"label sequences differ in length: {len(reference)} vs {len(predicted)}"
        )
    n = len(reference)
    if n == 0:
        return Agreement(axis=axis, n=0, observed=0.0, expected=0.0, kappa=0.0, weighted=False)

    labels = tuple(ordinal) if ordinal else tuple(sorted(set(reference) | set(predicted)))
    weights = _weights(labels, ordinal is not None)

    confusion = Counter(zip(reference, predicted))
    ref_counts = Counter(reference)
    pred_counts = Counter(predicted)

    observed = sum(
        weights[(a, b)] * count for (a, b), count in confusion.items()
    ) / n
    expected = sum(
        weights[(a, b)] * ref_counts[a] * pred_counts[b] for a in labels for b in labels
    ) / (n * n)

    return Agreement(
        axis=axis,
        n=n,
        observed=observed,
        expected=expected,
        kappa=_kappa(observed, expected),
        weighted=ordinal is not None,
        confusion=dict(confusion),
        labels=labels,
    )


def _kappa(observed: float, expected: float) -> float:
    """(p_o - p_e) / (1 - p_e), guarding the degenerate case.

    When chance agreement is already total — both raters used a single, identical
    label — kappa is undefined. Perfect agreement on a constant is reported as 1,
    and anything less as 0, rather than dividing by zero.
    """
    if expected >= 1.0:
        return 1.0 if observed >= 1.0 else 0.0
    return (observed - expected) / (1.0 - expected)


def _weights(labels: tuple[str, ...], ordinal: bool) -> dict[tuple[str, str], float]:
    """Credit for each (reference, predicted) pair.

    Nominal: 1 on the diagonal, 0 elsewhere. Ordinal: linear credit by distance,
    so adjacent confusions cost less than distant ones.
    """
    if not ordinal:
        return {(a, b): 1.0 if a == b else 0.0 for a in labels for b in labels}

    index = {label: i for i, label in enumerate(labels)}
    span = max(len(labels) - 1, 1)
    return {
        (a, b): 1.0 - abs(index[a] - index[b]) / span for a in labels for b in labels
    }


def confusion_grid(result: Agreement) -> list[list[str]]:
    """The confusion matrix as rows of strings, for terminal display."""
    header = ["ref \\ pred", *result.labels, "total"]
    rows = [header]
    for ref in result.labels:
        counts = [result.confusion.get((ref, pred), 0) for pred in result.labels]
        rows.append([ref, *(str(c) for c in counts), str(sum(counts))])
    totals = [
        str(sum(result.confusion.get((ref, pred), 0) for ref in result.labels))
        for pred in result.labels
    ]
    rows.append(["total", *totals, str(result.n)])
    return rows
