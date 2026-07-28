# TokenLens

**AI spend analytics and waste intelligence.**

Observability platforms (Helicone, Langfuse, LiteLLM) report what you spent.
TokenLens estimates what you *should* have spent and scores the gap. It is a
judgment layer over their exports, not a competing dashboard — point it at a
usage log and it tells you which of that spend was defensible.

Built as a portfolio project, and validated against real Claude Code usage rather
than invented data.

**[Live demo →](https://utkarshpatil02.github.io/tokenlens/)** — real figures from
one developer's history, with prompt text redacted. It is a frozen snapshot, not
a live backend: analysis reads local session logs, which exist only on the
machine that produced them.

## What it does

1. **Ingests** usage logs — Claude Code session JSONL today, with a common
   `Turn`/`Call` model that single-shot exports (Helicone, OpenRouter) drop into.
2. **Prices** every call, cache-aware, from a dated rate table.
3. **Classifies** each prompt by task category and complexity via Claude Haiku,
   escalating ambiguous ones to Sonnet.
4. **Scores** waste in dollars: model overshoot, context bloat, zero-value usage.
5. **Presents** it — CLI reports and a React dashboard.

## Three findings that changed the design

These came from inspecting real logs before writing the scorer. Each one would
have produced confidently wrong numbers if the original spec had been built as
written.

**Uncached input is ~0.0% of spend.** In the reference dataset, cost is 58% cache
reads, 34% cache writes, 8% output — and **$0.004** of uncached input. The
original bloat formula measured `input_tokens`, so it would have scored zero for
every record no matter how bloated. Bloat is now measured on `cache_read` for
agentic data, and cache writes are split by TTL because the 1-hour tier bills at
2× base against the 5-minute tier's 1.25×.

**Naive parsing overstated spend by 64%.** Claude Code writes one record per
*content block* of a response — thinking, text, tool_use — each repeating the same
`message.id` and the same usage object, because that usage bills the whole
response. Separately, a resumed session copies its predecessor's history forward
under a new session id. Counting records instead of messages gave $71.82 where
the truth was $25.84.

**Overshoot and bloat double-counted.** Pricing bloat at the tier actually used
bills the excess tokens twice, since overshoot already charges the model-choice
delta across all of them. On the reference worked example that pushed reported
waste *above* the amount spent. Pricing bloat at the **required** tier makes the
components disjoint: they now sum to exactly `actual − ideal`, which is an
asserted invariant.

## The Waste Score

Denominated in dollars, not weighted points. An earlier design used fixed weights
(45 overshoot / 35 bloat / 20 zero-value), which invited "why 45 and not 40" with
no real answer. Pricing the components directly removes the judgement call — the
figure derives from the same rate sheet the vendor bills against.

| Component | Definition |
|---|---|
| `overshoot_$` | Each call's tokens repriced on the reference model for the tier the task actually required |
| `bloat_$` | Tokens beyond the corpus median for comparable work, priced at the **required** tier |
| `zero_value` | Busywork forfeits its whole cost — no cheaper tier is the remedy |
| `turn_efficiency` | Calls vs. the median for that difficulty. A diagnostic, never priced: that cost already sits in `cache_read` |

Two invariants from the earlier formula are named regression tests:

- Using a **cheaper** model than required never scores as waste. It flags
  `under_provisioned` instead — that is a quality risk, not a saving.
- A **bloated prompt on a correctly chosen model** still scores as waste. The old
  multiplicative form multiplied bloat by an overshoot of zero, hiding half of
  what it existed to measure.

Bloat is withheld entirely when a category/complexity cell has fewer than five
comparable turns. A median over two turns is noise, and reporting it as a finding
would be worse than reporting nothing.

## Data

The real case study is the author's own Claude Code history — genuine per-request
model, token, and timestamp values, priced from published rates. No public
dataset of real per-call spend exists, because that is billing data and nobody
publishes it.

Current reference set: **58 turns, 513 requests, 8 sessions, $108.18** — averaging
8.8 calls per prompt and peaking at 60. That agentic shape is why scoring happens
per *turn* rather than per call.

Only public, license-compliant data or the user's own exports are used. No
authentication is bypassed and no private repositories are accessed.

## Validation

Classifier agreement is reported as **Cohen's kappa** alongside raw percent
agreement, and kappa is the figure that carries the claim: on a skewed label mix,
answering the most common class every time scores well on raw agreement while
learning nothing.

- **Complexity uses linearly weighted kappa**, since the axis is ordinal —
  confusing trivial with complex is worse than confusing trivial with moderate.
- **Agreement is reported before and after escalation.** Escalation costs money;
  claiming it helps without the earlier number would be unfalsifiable.
- **A second labeller gives the human-to-human ceiling.** A classifier matching
  one labeller 80% of the time means something different depending on whether two
  humans agree 95% or 80%.

```bash
uv run python -m tokenlens.validate_cli export labels.csv --limit 100
#  ... label by hand, before looking at classifier output ...
uv run python -m tokenlens.validate_cli report labels.csv --second reviewer.csv
```

## Running it

**Backend** (Python 3.12+, [uv](https://docs.astral.sh/uv/)):

```bash
cd backend && uv sync --extra dev && uv run pytest
```

```bash
uv run python -m tokenlens.report                      # spend report
uv run python -m tokenlens.classify_cli --dry-run      # cost preview, no API calls
uv run uvicorn tokenlens.api:app --port 8000           # API
```

**Dashboard** (Node 20.19+ or 22.12+ — see [frontend/README.md](frontend/README.md)):

```bash
cd frontend && npm install && npm run dev
```

**Publishing a snapshot.** The deployed site is static, so it serves a frozen
export. Prompt text is redacted by default and an assertion fails the export if
any survives; the CI workflow re-checks before deploying.

```bash
uv run python -m tokenlens.snapshot ../frontend/public/snapshot.json
```

Classification is the only step that costs money and requires `ANTHROPIC_API_KEY`.
It never runs implicitly: `GET /api/analysis` serves what is already cached, and
issuing new requests takes an explicit `POST /api/classify`. Results cache by
content hash, so re-runs are free.

**Running it without an API key.** Hand labels stand in for classifier output, so
scoring, the heatmap, and the leaderboard all work for nothing:

```bash
uv run python -m tokenlens.validate_cli export labels.csv   # then label by hand
TOKENLENS_LABELS=labels.csv uv run uvicorn tokenlens.api:app --port 8000
```

This is not a degraded mode — for the turns covered, a human judgement is a
better input than a prediction. What it cannot do is measure the classifier, so
results are stamped `hand-labelled` and validation refuses to score labels
against themselves, which would report perfect agreement and prove nothing.

## Scope and limits

- **Not a production SaaS.** No auth, no multi-tenancy, no live proxy.
- **The case study is personal-scale.** One developer's history is real, but it is
  not an organisation's spend, and the org-scale framing rests on that
  distinction being stated rather than glossed.
- **Team analytics were cut.** No public source contains organisational
  structure; fabricating the one field a "cost by team" view leads with would
  undermine everything beside it.
- **Rate tables drift.** The table is dated and versioned, and every reported
  figure names the version that produced it.

## Layout

```
backend/tokenlens/
  pricing.py            cache-aware cost engine + dated rate table
  models.py             Turn / Call — the shared data model
  ingest/claude_code.py JSONL parsing, turn grouping, deduplication
  classify/             Haiku classifier, confidence escalation, SQLite cache
  scoring/              dollar-denominated Waste Score + corpus baselines
  validation/           Cohen's kappa, confusion matrices, label sets
  analysis.py           the payload the dashboard renders
  api.py                FastAPI
frontend/src/           React dashboard
```

## Docs

- [PRD v2.1](Documents/TokenLens_PRD_v2.docx) — current
- [PRD v1.0](Documents/TokenLens_PRD.docx) — superseded, kept for history
