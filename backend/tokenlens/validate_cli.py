"""Validation workflow.

    python -m tokenlens.validate_cli export labels.csv --limit 100
    #  ... fill in category and complexity by hand ...
    python -m tokenlens.validate_cli report labels.csv
    python -m tokenlens.validate_cli report labels.csv --second reviewer.csv

Export before classifying. Labelling against visible classifier output anchors
the reference set to the thing it is supposed to evaluate.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from tokenlens.analysis import build_analysis
from tokenlens.classify_cli import DEFAULT_CACHE
from tokenlens.ingest import parse_projects
from tokenlens.report import DEFAULT_PROJECTS
from tokenlens.validation import (
    LabelError,
    LabelSet,
    build_report,
    export_template,
    format_report,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tokenlens.validate_cli",
        description="Export a labelling sheet, or report classifier agreement.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    export = sub.add_parser("export", help="write a blank labelling sheet")
    export.add_argument("output", type=Path)
    export.add_argument("--path", default=DEFAULT_PROJECTS, type=Path)
    export.add_argument("--limit", type=int, help="cap the number of prompts")

    report = sub.add_parser("report", help="compare hand labels against the classifier")
    report.add_argument("labels", type=Path)
    report.add_argument(
        "--second", type=Path, help="a second labeller's sheet, for a human baseline"
    )
    report.add_argument("--path", default=DEFAULT_PROJECTS, type=Path)
    report.add_argument("--cache", default=DEFAULT_CACHE, type=Path)
    report.add_argument("--json", action="store_true", help="emit JSON instead of text")

    args = parser.parse_args(argv)

    if args.command == "export":
        return _export(args, parser)
    return _report(args, parser)


def _export(args, parser) -> int:
    if not args.path.exists():
        parser.error(f"no such directory: {args.path}")

    turns = parse_projects(args.path)
    written = export_template(turns, args.output, limit=args.limit)
    if not written:
        print("No prompts with text found; nothing to label.")
        return 0

    print(f"Wrote {written} prompts to {args.output}")
    print()
    print("Fill in the 'category' and 'complexity' columns for each row:")
    print("  category    coding | research | writing | summarization | busywork")
    print("  complexity  trivial | moderate | complex")
    print()
    print("Label before looking at classifier output, so the reference set stays")
    print("independent of what it is meant to evaluate. For a human baseline, have")
    print("someone else label a subset of the same sheet and pass it as --second.")
    return 0


def _report(args, parser) -> int:
    if not args.labels.exists():
        parser.error(f"no such file: {args.labels}")
    if args.second and not args.second.exists():
        parser.error(f"no such file: {args.second}")

    try:
        labels = LabelSet.load(args.labels)
        second = LabelSet.load(args.second) if args.second else None
    except LabelError as exc:
        parser.error(str(exc))
        return 2  # unreachable; parser.error exits

    if not labels:
        parser.error(f"{args.labels} has no completed rows yet")

    analysis = build_analysis(args.path, cache_path=args.cache)
    if not analysis.classifications:
        print(f"{len(labels)} prompts labelled, but none have been classified yet.")
        print("Run: python -m tokenlens.classify_cli")
        return 1

    report = build_report(
        analysis.turns, analysis.classifications, labels, second_labels=second
    )

    if args.json:
        print(json.dumps(report.as_dict(), indent=2))
    else:
        print(format_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
