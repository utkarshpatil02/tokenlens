"""Case study report.

Prints a real dollar breakdown of Claude Code usage. This exists to answer the
question the whole project rests on — "what did my AI usage actually cost, and
what was it spent on" — against genuine logs rather than a formula applied to
invented data.

    python -m tokenlens.report                    # default projects directory
    python -m tokenlens.report <path> --top 20
"""

from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal
from pathlib import Path

from tokenlens.ingest import parse_projects
from tokenlens.models import Turn
from tokenlens.pricing import PriceTable, default_table

DEFAULT_PROJECTS = Path.home() / ".claude" / "projects"

# Order the cost table by how the money actually breaks down in agentic usage,
# rather than alphabetically.
_CATEGORY_LABELS = {
    "cache_read": "cache read",
    "cache_write_1h": "cache write (1h)",
    "cache_write_5m": "cache write (5m)",
    "output_tokens": "output",
    "input_tokens": "input (uncached)",
}


def build_report(turns: list[Turn], table: PriceTable | None = None) -> dict:
    """Aggregate turns into the figures the report prints."""
    table = table or default_table()

    by_category: Counter[str] = Counter()
    by_model: Counter[str] = Counter()
    tokens: Counter[str] = Counter()
    total = Decimal(0)

    turn_costs: list[tuple[Decimal, Turn]] = []

    for turn in turns:
        turn_total = Decimal(0)
        for call in turn.calls:
            cost = table.cost_of(call)
            turn_total += cost
            by_model[call.model] += cost
            for category, amount in table.cost_breakdown(call).items():
                by_category[category] += amount
            for category in _CATEGORY_LABELS:
                tokens[category] += getattr(call, category)
        total += turn_total
        turn_costs.append((turn_total, turn))

    scorable = [t for t in turns if t.is_scorable]
    calls = [c for t in turns for c in t.calls]

    return {
        "total": total,
        "turns": len(turns),
        "scorable_turns": len(scorable),
        "calls": len(calls),
        "by_category": by_category,
        "by_model": by_model,
        "tokens": tokens,
        "calls_per_turn": Counter(t.call_count for t in turns),
        "ranked_turns": sorted(turn_costs, key=lambda pair: pair[0], reverse=True),
        "table": table,
    }


def format_report(report: dict, top: int = 10) -> str:
    total: Decimal = report["total"]
    table: PriceTable = report["table"]
    out: list[str] = []

    def line(text: str = "") -> None:
        out.append(text)

    # ASCII only: the Windows console default codepage mangles em-dashes and
    # ellipses, which makes correct output look broken.
    line("TokenLens - Claude Code usage")
    line(f"rate table v{table.version}, updated {table.updated} ({table.currency})")
    line()

    if not report["calls"]:
        line("No billable calls found.")
        return "\n".join(out)

    line(f"  total spend        {_money(total)}")
    line(f"  API requests       {report['calls']:,}")
    line(
        f"  turns              {report['turns']:,} "
        f"({report['scorable_turns']:,} with prompt text)"
    )
    line(f"  mean calls / turn  {report['calls'] / report['turns']:.1f}")
    line()

    line("Where the money went")
    for category, cost in report["by_category"].most_common():
        if not cost:
            continue
        label = _CATEGORY_LABELS.get(category, category)
        share = cost / total * 100 if total else Decimal(0)
        line(
            f"  {label:<18} {_money(cost)}  {share:5.1f}%   "
            f"{report['tokens'][category]:>12,} tok"
        )
    line()

    line("By model")
    for model, cost in report["by_model"].most_common():
        share = cost / total * 100 if total else Decimal(0)
        line(f"  {model:<24} {_money(cost)}  {share:5.1f}%")
    line()

    line("Calls per turn")
    line(f"  {_histogram(report['calls_per_turn'])}")
    line()

    line(f"Most expensive turns (top {top})")
    for cost, turn in report["ranked_turns"][:top]:
        prompt = turn.prompt_text or "(unattributed - no prompt text)"
        line(f"  {_money(cost)}  {turn.call_count:>3} calls  {_snippet(prompt)}")

    return "\n".join(out)


def _money(value: Decimal) -> str:
    return f"${value:>9.4f}"


def _snippet(text: str, width: int = 58) -> str:
    flat = " ".join(text.split())
    if len(flat) > width:
        flat = flat[: width - 3] + "..."
    return flat


def _histogram(counts: Counter[int]) -> str:
    return "  ".join(f"{calls}x{count}" for calls, count in sorted(counts.items()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tokenlens.report",
        description="Report real Claude Code spend from local session logs.",
    )
    parser.add_argument(
        "path",
        nargs="?",
        default=DEFAULT_PROJECTS,
        type=Path,
        help="Claude Code projects directory (default: ~/.claude/projects)",
    )
    parser.add_argument(
        "--top", type=int, default=10, help="how many expensive turns to list"
    )
    args = parser.parse_args(argv)

    if not args.path.exists():
        parser.error(f"no such directory: {args.path}")

    turns = parse_projects(args.path)
    print(format_report(build_report(turns), top=args.top))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
