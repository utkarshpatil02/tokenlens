"""Classify real prompts and show the distribution.

    python -m tokenlens.classify_cli --dry-run     # cost estimate, no API calls
    python -m tokenlens.classify_cli               # classify (uses cache)
    python -m tokenlens.classify_cli --labels labels.csv --dry-run

Requires ANTHROPIC_API_KEY unless every prompt is already cached.

`--labels` restricts the run to the prompts a label sheet covers, which is what
validation actually needs: the kappa is computed over the turns that have a hand
label, and classifying the rest of the corpus to get it is money spent on
prompts the comparison will ignore. `--limit` cannot stand in for this — it
takes the first N in corpus order, and labelled turns are scattered through it.
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from tokenlens.classify import Classifier, ClassificationCache, PROMPT_VERSION, cache_key
from tokenlens.ingest import parse_projects
from tokenlens.report import DEFAULT_PROJECTS, _snippet
from tokenlens.validation import LabelError, LabelSet

DEFAULT_CACHE = Path.home() / ".tokenlens" / "classifications.db"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tokenlens.classify_cli",
        description="Classify prompts from local Claude Code logs.",
    )
    parser.add_argument("path", nargs="?", default=DEFAULT_PROJECTS, type=Path)
    parser.add_argument("--cache", default=DEFAULT_CACHE, type=Path)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report how many prompts would be sent, without calling the API",
    )
    parser.add_argument("--limit", type=int, help="classify at most this many prompts")
    parser.add_argument(
        "--labels",
        type=Path,
        help="only classify prompts covered by this label sheet (for validation)",
    )
    args = parser.parse_args(argv)

    if not args.path.exists():
        parser.error(f"no such directory: {args.path}")

    turns = [t for t in parse_projects(args.path) if t.is_scorable]

    if args.labels:
        try:
            wanted = LabelSet.load(args.labels).turn_ids
        except (LabelError, OSError) as error:
            parser.error(str(error))

        turns = [t for t in turns if t.turn_id in wanted]

        # A label whose turn is no longer in the logs cannot be compared against
        # anything, and silently classifying 40 of 65 would produce a kappa over
        # a quietly different reference set than the one being claimed.
        missing = len(wanted) - len(turns)
        if missing:
            print(
                f"warning: {missing} of {len(wanted)} labelled turn(s) are not in "
                f"{args.path} and will be left out of the comparison"
            )
        if not turns:
            parser.error(f"no labelled prompt in {args.labels.name} appears in {args.path}")

    if args.limit:
        turns = turns[: args.limit]

    if not turns:
        print("No scorable prompts found.")
        return 0

    with ClassificationCache(args.cache) as cache:
        classifier = Classifier(cache=cache)
        uncached = [
            t
            for t in turns
            if cache.get(cache_key(t.prompt_text, PROMPT_VERSION, classifier.pipeline_id))
            is None
        ]

        print(f"prompts        {len(turns)}")
        print(f"already cached {len(turns) - len(uncached)}")
        print(f"to classify    {len(uncached)}")

        if args.dry_run:
            print()
            print("Dry run - no API calls made.")
            print(f"Cache: {args.cache}")
            return 0

        if uncached:
            print(f"\nClassifying {len(uncached)} prompt(s)...")

        results = classifier.classify_turns(turns)
        _summarise(results, turns)

    return 0


def _summarise(results: dict, turns: list) -> None:
    if not results:
        print("Nothing classified.")
        return

    values = list(results.values())
    categories = Counter(r.category.value for r in values)
    complexities = Counter(r.complexity.value for r in values)
    escalated = [r for r in values if r.escalated]
    changed = [r for r in escalated if r.complexity_changed_on_escalation]

    print()
    print("Category")
    for name, count in categories.most_common():
        print(f"  {name:<16} {count:>3}")

    print()
    print("Complexity")
    for name in ("trivial", "moderate", "complex"):
        if complexities.get(name):
            print(f"  {name:<16} {complexities[name]:>3}")

    print()
    print("Escalation")
    print(f"  escalated        {len(escalated):>3} of {len(values)}")
    print(f"  changed the tier {len(changed):>3}")
    mean_conf = sum(r.confidence for r in values) / len(values)
    print(f"  mean confidence  {mean_conf:.2f}")

    by_id = {t.turn_id: t for t in turns}
    print()
    print("Sample")
    for turn_id, result in list(results.items())[:8]:
        prompt = by_id[turn_id].prompt_text or ""
        flag = " *escalated" if result.escalated else ""
        print(
            f"  [{result.category.value}/{result.complexity.value} "
            f"{result.confidence:.2f}{flag}] {_snippet(prompt, 44)}"
        )


if __name__ == "__main__":
    raise SystemExit(main())
