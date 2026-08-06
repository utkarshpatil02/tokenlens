"""Publishable snapshot.

    python -m tokenlens.snapshot ../frontend/public/snapshot.json

A deployed dashboard cannot read `~/.claude/projects` — that directory exists
only on the machine that produced it — so a public demo is served from a frozen
snapshot rather than a live backend.

Publishing is one-way: once a file is on a public URL it may be cached and
indexed beyond anyone's control. Prompt text is therefore redacted by default
rather than on request, and `--include-prompts` has to be passed deliberately.
Redaction covers the classifier's rationale too, since it is written *about* the
prompt and routinely restates its content.

Aggregate figures — spend, composition, tier distribution, calls per turn — carry
every finding the project makes and contain no prompt text at all, so the
redacted snapshot is not a diminished demo.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from tokenlens.analysis import build_analysis
from tokenlens.classify_cli import DEFAULT_CACHE
from tokenlens.report import DEFAULT_PROJECTS

# Keys whose values are, or may quote, what the user typed.
_SENSITIVE_KEYS = ("prompt", "rationale")


def redact(payload: dict) -> dict:
    """Strip user-written text, keeping every figure.

    Prompt length survives as a bare character count: it explains why a turn is
    expensive without disclosing content.
    """
    waste = payload.get("waste")
    if not waste:
        return payload

    for row in waste.get("leaderboard", []):
        prompt = row.get("prompt")
        row["prompt"] = (
            f"(redacted · {len(prompt)} chars)" if prompt else "(no prompt text)"
        )
        if row.get("rationale"):
            row["rationale"] = "(rationale redacted)"
    return payload


def assert_redacted(payload: dict) -> None:
    """Fail loudly if any user-written text survived.

    A silent redaction bug publishes private data, so this runs on every export
    rather than being trusted to the function above.
    """
    waste = payload.get("waste")
    if not waste:
        return
    for row in waste.get("leaderboard", []):
        for key in _SENSITIVE_KEYS:
            value = row.get(key)
            if value and "redact" not in value and value != "(no prompt text)":
                raise AssertionError(
                    f"redaction failed: leaderboard row still carries {key!r}"
                )


def build_snapshot(
    projects_path: Path | str,
    cache_path: Path | str | None = None,
    include_prompts: bool = False,
    labels_path: Path | str | None = None,
) -> dict:
    payload = build_analysis(
        projects_path, cache_path=cache_path, labels_path=labels_path
    ).to_payload()
    payload["snapshot"] = {
        "static": True,
        "prompts_redacted": not include_prompts,
    }
    if include_prompts:
        return payload

    payload = redact(payload)
    assert_redacted(payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tokenlens.snapshot",
        description="Freeze an analysis for static hosting.",
    )
    parser.add_argument("output", type=Path)
    parser.add_argument("--path", default=DEFAULT_PROJECTS, type=Path)
    parser.add_argument("--cache", default=DEFAULT_CACHE, type=Path)
    parser.add_argument(
        "--include-prompts",
        action="store_true",
        help="publish prompt text verbatim (off by default; this is irreversible)",
    )
    # Without this the export could only ever publish cached classifier output,
    # so a project labelled by hand had no way to show a waste score at all --
    # which is exactly what the published snapshot was missing.
    parser.add_argument(
        "--labels",
        default=os.getenv("TOKENLENS_LABELS"),
        type=Path,
        help="hand labels standing in for classifier output "
        "(defaults to $TOKENLENS_LABELS, as the API reads it)",
    )
    args = parser.parse_args(argv)

    if not args.path.exists():
        parser.error(f"no such directory: {args.path}")
    if args.labels is not None and not Path(args.labels).exists():
        parser.error(f"no such label file: {args.labels}")

    payload = build_snapshot(
        args.path,
        cache_path=args.cache,
        include_prompts=args.include_prompts,
        labels_path=args.labels,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    overview = payload["overview"]
    print(f"Wrote {args.output} ({args.output.stat().st_size:,} bytes)")
    print(
        f"  {overview['calls']} requests · {overview['turns']} turns · "
        f"${float(overview['total_cost']):.2f}"
    )
    if args.include_prompts:
        print()
        print("  WARNING: prompt text is included verbatim and will be public.")
        print("  Read the file before publishing it.")
    else:
        print("  prompt text: redacted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
