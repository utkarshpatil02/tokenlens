"""Analysis payload.

Assembles ingestion, classification, and scoring into the single structure the
dashboard renders. Two properties drive the design:

Money is serialised as a decimal string, never a JSON number. A float round-trip
would silently perturb figures the project asks people to trust.

Spend analysis and waste analysis are separated. Composition, per-model cost, and
turn shape need no classification and are always available from local logs.
Waste requires classified prompts, so it is a nullable section with an explicit
reason when absent — rather than rendering zeros that read as "no waste found"
when the truth is "not yet measured".
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from tokenlens.classify import Classification, ClassificationCache, Classifier
from tokenlens.classify.schema import Category, Complexity
from tokenlens.ingest import parse_projects
from tokenlens.models import Turn
from tokenlens.pricing import TOKEN_CATEGORIES, PriceTable, default_table
from tokenlens.scoring import BloatBaseline, Scorer, WasteScore, calls_baseline_from

# Ordered for display: how agentic spend actually breaks down.
_CATEGORY_ORDER = (
    "cache_read",
    "cache_write_1h",
    "cache_write_5m",
    "output_tokens",
    "input_tokens",
)

_CATEGORY_LABELS = {
    "cache_read": "cache read",
    "cache_write_1h": "cache write (1h)",
    "cache_write_5m": "cache write (5m)",
    "output_tokens": "output",
    "input_tokens": "input (uncached)",
}


@dataclass(slots=True)
class Analysis:
    """Everything the dashboard needs, already aggregated."""

    turns: list[Turn]
    classifications: dict[str, Classification]
    scores: list[WasteScore]
    table: PriceTable
    baseline: BloatBaseline

    def to_payload(self) -> dict:
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "rate_table": {
                "version": self.table.version,
                "updated": self.table.updated.isoformat(),
                "currency": self.table.currency,
            },
            "overview": self._overview(),
            "cost_by_token_category": self._by_token_category(),
            "cost_by_model": self._by_model(),
            "calls_per_turn": self._calls_per_turn(),
            "waste": self._waste(),
        }

    # --- spend: always available -----------------------------------------

    def _total_cost(self) -> Decimal:
        return sum(
            (self.table.cost_of(c) for t in self.turns for c in t.calls), Decimal(0)
        )

    def _overview(self) -> dict:
        calls = [c for t in self.turns for c in t.calls]
        scorable = [t for t in self.turns if t.is_scorable]
        total = self._total_cost()
        return {
            "total_cost": _money(total),
            "turns": len(self.turns),
            "scorable_turns": len(scorable),
            "classified_turns": len(self.classifications),
            "calls": len(calls),
            "mean_calls_per_turn": round(len(calls) / len(self.turns), 2)
            if self.turns
            else 0.0,
            "total_tokens": sum(c.total_tokens for c in calls),
            "sessions": len({t.session_id for t in self.turns if t.session_id}),
        }

    def _by_token_category(self) -> list[dict]:
        costs: Counter[str] = Counter()
        tokens: Counter[str] = Counter()
        for turn in self.turns:
            for call in turn.calls:
                for category, cost in self.table.cost_breakdown(call).items():
                    costs[category] += cost
                for category in TOKEN_CATEGORIES:
                    tokens[category] += getattr(call, category)

        total = self._total_cost()
        return [
            {
                "category": category,
                "label": _CATEGORY_LABELS[category],
                "cost": _money(costs[category]),
                "tokens": tokens[category],
                "share": _share(costs[category], total),
            }
            for category in _CATEGORY_ORDER
            if tokens[category] or costs[category]
        ]

    def _by_model(self) -> list[dict]:
        costs: Counter[str] = Counter()
        calls: Counter[str] = Counter()
        for turn in self.turns:
            for call in turn.calls:
                costs[call.model] += self.table.cost_of(call)
                calls[call.model] += 1

        total = self._total_cost()
        return [
            {
                "model": model,
                "tier": self.table.tier_of(model),
                "cost": _money(cost),
                "calls": calls[model],
                "share": _share(cost, total),
            }
            for model, cost in costs.most_common()
        ]

    def _calls_per_turn(self) -> list[dict]:
        counts = Counter(t.call_count for t in self.turns)
        return [
            {"calls": calls, "turns": turns} for calls, turns in sorted(counts.items())
        ]

    # --- waste: requires classification ----------------------------------

    def _waste(self) -> dict | None:
        if not self.scores:
            return None

        by_id = {t.turn_id: t for t in self.turns}
        total_waste = sum((s.estimated_waste for s in self.scores), Decimal(0))
        scored_cost = sum((s.actual_cost for s in self.scores), Decimal(0))

        return {
            "total_waste": _money(total_waste),
            "scored_cost": _money(scored_cost),
            "waste_share": _share(total_waste, scored_cost),
            "scored_turns": len(self.scores),
            "unmeasured_bloat_turns": sum(1 for s in self.scores if not s.bloat_measured),
            # The dashboard says which produced these figures, so a hand-labelled
            # run is never mistaken for a classified one.
            "source": self._classification_source(),
            "components": {
                "overshoot": _money(sum((s.overshoot_cost for s in self.scores), Decimal(0))),
                "bloat": _money(sum((s.bloat_cost for s in self.scores), Decimal(0))),
                "zero_value_cost": _money(
                    sum((s.actual_cost for s in self.scores if s.zero_value), Decimal(0))
                ),
            },
            "bands": self._bands(),
            "complexity_by_tier": self._heatmap(),
            "category_distribution": self._distribution(),
            "leaderboard": self._leaderboard(by_id),
            "flags": {
                "under_provisioned": sum(1 for s in self.scores if s.under_provisioned),
                "zero_value": sum(1 for s in self.scores if s.zero_value),
                "escalated": sum(1 for c in self.classifications.values() if c.escalated),
                "escalation_changed_tier": sum(
                    1
                    for c in self.classifications.values()
                    if c.complexity_changed_on_escalation
                ),
            },
        }

    def _classification_source(self) -> dict:
        """Where the labels behind the waste figures came from, and from which models.

        This was a single word until a second provider existed. It stopped being
        enough at that point: a score labelled by Gemini and one labelled by
        Haiku are different measurements, and one word presents them as the
        same. Escalation makes it sharper still — a single Claude run produces
        labels from two models, and how many escalated is exactly what a reader
        wants to know.

        Only *scored* turns count. A classification for a turn that never
        reached the scores describes nothing in the payload, and letting it name
        a model would attribute figures to a model that did not produce them.

        Models are ordered most-used first; ties keep first-seen order, so the
        same corpus always renders the same line.
        """
        scored_ids = {s.turn_id for s in self.scores}
        counts: Counter[str] = Counter()
        human = 0

        for turn_id, found in self.classifications.items():
            if turn_id not in scored_ids:
                continue
            if found.is_human:
                human += 1
                continue
            counts[found.model] += 1

        if not human:
            kind = "classifier"
        elif human == len(scored_ids):
            kind = "hand-labelled"
        else:
            kind = "mixed"

        return {
            "kind": kind,
            # `most_common` is a stable sort, so equal counts keep insertion
            # order rather than shuffling between runs.
            "models": [
                {"model": model, "turns": turns} for model, turns in counts.most_common()
            ],
            "human_turns": human,
        }

    def _bands(self) -> list[dict]:
        counts: Counter[str] = Counter()
        costs: Counter[str] = Counter()
        for score in self.scores:
            counts[score.band.value] += 1
            costs[score.band.value] += score.actual_cost
        return [
            {
                "band": band,
                "turns": counts.get(band, 0),
                "cost": _money(costs.get(band, Decimal(0))),
            }
            for band in ("efficient", "moderate", "high", "critical")
        ]

    def _heatmap(self) -> list[dict]:
        """Complexity against tier used. The waste lives above the diagonal."""
        cells: dict[tuple[str, int], dict] = {}
        for score in self.scores:
            found = self.classifications[score.turn_id]
            key = (found.complexity.value, score.tier_used)
            cell = cells.setdefault(
                key,
                {
                    "complexity": found.complexity.value,
                    "required_tier": found.required_tier,
                    "tier_used": score.tier_used,
                    "turns": 0,
                    "_cost": Decimal(0),
                    "_waste": Decimal(0),
                },
            )
            cell["turns"] += 1
            cell["_cost"] += score.actual_cost
            cell["_waste"] += score.estimated_waste

        out = []
        for cell in cells.values():
            cost, waste = cell.pop("_cost"), cell.pop("_waste")
            out.append({**cell, "cost": _money(cost), "waste": _money(waste)})
        return sorted(out, key=lambda c: (c["required_tier"], c["tier_used"]))

    def _distribution(self) -> list[dict]:
        costs: Counter[str] = Counter()
        counts: Counter[str] = Counter()
        for score in self.scores:
            category = self.classifications[score.turn_id].category.value
            costs[category] += score.actual_cost
            counts[category] += 1
        return [
            {"category": category, "turns": counts[category], "cost": _money(cost)}
            for category, cost in costs.most_common()
        ]

    def _leaderboard(self, by_id: dict[str, Turn], limit: int = 20) -> list[dict]:
        ranked = sorted(self.scores, key=lambda s: s.estimated_waste, reverse=True)
        rows = []
        for score in ranked[:limit]:
            found = self.classifications[score.turn_id]
            turn = by_id[score.turn_id]
            rows.append(
                {
                    "turn_id": score.turn_id,
                    "prompt": turn.prompt_text,
                    "category": found.category.value,
                    "complexity": found.complexity.value,
                    "confidence": round(found.confidence, 2),
                    "escalated": found.escalated,
                    "rationale": found.rationale,
                    "calls": score.call_count,
                    "actual_cost": _money(score.actual_cost),
                    "estimated_waste": _money(score.estimated_waste),
                    "overshoot": _money(score.overshoot_cost),
                    "bloat": _money(score.bloat_cost),
                    "excess_tokens": score.excess_tokens,
                    "bloat_measured": score.bloat_measured,
                    "tier_used": score.tier_used,
                    "tier_required": score.tier_required,
                    "normalized": score.normalized,
                    "band": score.band.value,
                    "zero_value": score.zero_value,
                    "under_provisioned": score.under_provisioned,
                    "recommendation": score.recommendation,
                }
            )
        return rows


def build_analysis(
    projects_path: Path | str,
    cache_path: Path | str | None = None,
    table: PriceTable | None = None,
    classify: bool = False,
    labels_path: Path | str | None = None,
) -> Analysis:
    """Build an analysis from local logs.

    Classification is read from cache only unless `classify` is set, so opening
    the dashboard never silently spends money on API calls.

    `labels_path` supplies hand labels where classifier output would go, which
    makes the whole waste analysis work without an API key. Labels take
    precedence over cached predictions for the turns they cover: a human
    judgement is the better input, and mixing the two silently would make it
    impossible to say which produced a given figure.
    """
    table = table or default_table()
    turns = parse_projects(projects_path)

    cache = ClassificationCache(cache_path) if cache_path else ClassificationCache()
    classifier = Classifier(cache=cache)
    classifications = (
        classifier.classify_turns(turns)
        if classify
        else _cached_only(classifier, turns)
    )

    if labels_path is not None:
        from tokenlens.validation.labels import LabelSet

        labelled = LabelSet.load(labels_path).to_classifications()
        known = {t.turn_id for t in turns}
        classifications |= {
            turn_id: found
            for turn_id, found in labelled.items()
            if turn_id in known
        }

    baseline = BloatBaseline.from_turns(turns, classifications)
    scorer = Scorer(
        baseline=baseline,
        table=table,
        calls_baseline=calls_baseline_from(turns, classifications),
    )
    return Analysis(
        turns=turns,
        classifications=classifications,
        scores=scorer.score_all(turns, classifications),
        table=table,
        baseline=baseline,
    )


def _cached_only(classifier: Classifier, turns: list[Turn]) -> dict[str, Classification]:
    """Classifications already paid for, without issuing new requests."""
    from tokenlens.classify import PROMPT_VERSION, cache_key

    found: dict[str, Classification] = {}
    for turn in turns:
        if not turn.is_scorable:
            continue
        key = cache_key(turn.prompt_text, PROMPT_VERSION, classifier.pipeline_id)
        cached = classifier.cache.get(key)
        if cached is not None:
            found[turn.turn_id] = cached
    return found


def _money(value: Decimal) -> str:
    """Serialise money as an exact string.

    A JSON float would perturb the value, and a fixed number of decimal places
    would round it — with per-token rates in the 1e-7 range, rounding makes
    component costs stop summing to their total. `format(..., "f")` keeps every
    digit and avoids the scientific notation `str()` produces for small values.
    Rounding is a presentation concern and belongs in the UI.
    """
    return format(value, "f")


def _share(part: Decimal, whole: Decimal) -> float:
    if whole <= 0:
        return 0.0
    return round(float(part / whole), 4)
