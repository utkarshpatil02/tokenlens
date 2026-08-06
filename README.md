# TokenLens

**AI spend analytics and waste intelligence.**

Observability platforms (Helicone, Langfuse, LiteLLM) report what you spent.
TokenLens estimates what you *should* have spent and scores the gap. It is a
judgment layer over their exports, not a competing dashboard — point it at a
usage log and it tells you which of that spend was defensible.

Built as a portfolio project, and validated against real Claude Code usage rather
than invented data.

**[Live demo →](https://utkarshpatil02.github.io/tokenlens/)** — real figures from
one developer's history, with prompt text redacted. Those are a frozen snapshot
rather than a live backend, because analysis reads local session logs that exist
only on the machine that produced them.

The same page reads **your own CSV export**, and reads it in the browser. Nothing
is uploaded: the file is parsed, priced and aggregated in the tab. That is not
only a privacy line — a server holding strangers' prompt logs would make this a
data processor, and classifying on the project's key would put every visitor's
usage on its credits.

## What it does

1. **Ingests** usage logs — Claude Code session JSONL, plus any CSV carrying a
   model column, normalised into a common `Turn`/`Call` model. Column detection
   knows the header spellings Claude Console, OpenAI, Helicone and OpenRouter
   use, but header names are not a standard, so the mapping is always shown for
   confirmation rather than applied silently.
2. **Prices** every call, cache-aware, from a dated rate table.
3. **Classifies** each prompt by task category and complexity via Claude Haiku,
   escalating ambiguous ones to Sonnet.
4. **Scores** waste in dollars: model overshoot, context bloat, zero-value usage.
5. **Presents** it — CLI reports, a React dashboard, and a browser-only path that
   needs no backend at all.

## Three findings that changed the design

These came from inspecting real logs before writing the scorer. Each one would
have produced confidently wrong numbers if the original spec had been built as
written.

**Uncached input is ~0.0% of spend.** In the reference dataset, cache traffic is
94% of cost — 50% reads, 44% writes — against 6.5% output and **$0.015** of
uncached input across 958 requests. The
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

## Two implementations, one source of truth

Pricing in the browser means the same rules exist twice — Python for the CLI,
TypeScript for the web app. The failure that matters is not one of them crashing,
it is the two quietly disagreeing, so the CLI and the demo report different
dollars for the same log with nothing to say which is right.

Neither is trusted on its own. `pricing.yaml` is the only rate table, and it
generates the JSON the browser reads. The Python engine then generates fixtures
of what it actually computes — per-call costs, the aggregated payload, per-turn
waste scores — and the TypeScript suite has to reproduce every figure. All four
generators have a `--check` mode so a stale fixture fails rather than drifts.

Three divergences this caught, none of which are bugs in either language:

- **Float money.** JavaScript has no decimal type, and at float precision the
  per-category costs stop summing to their total. Money is a bigint count of
  pico-dollars; a rate too precise to divide exactly is rejected rather than
  rounded.
- **Rounding.** Python rounds halves to even, JavaScript away from zero, so a
  share of exactly 5/32 differs in the fourth decimal.
- **Tie order.** `Counter.most_common` is a stable sort, so models costing the
  same keep first-seen order.

Comparison is numeric rather than textual: `Decimal` carries an exponent into its
string form, so Python's `"39.995350"` and the port's `"39.99535"` are the same
money and holding one to the other's spelling would test the wrong thing.

## Data

The real case study is the author's own Claude Code history — genuine per-request
model, token, and timestamp values, priced from published rates. No public
dataset of real per-call spend exists, because that is billing data and nobody
publishes it.

That history now includes the sessions that built TokenLens, so the tool scores
its own construction. Convenient, and worth stating rather than leaving for a
reader to notice: it means the corpus is one person doing one kind of work, which
is the same limitation as the personal-scale caveat below, not a separate one.

Current reference set: **102 turns, 958 requests, 11 sessions, $271.10** —
averaging 9.4 calls per prompt and peaking at 60. That agentic shape is why
scoring happens per *turn* rather than per call.

**What it found: $71.61 of waste, 41.6%.** That share is of the $171.99 covered
by hand labels, not of the full $271.10 — 37 turns carry no label and no waste
figure, and the dashboard states both numbers rather than quietly implying the
larger one. Bloat ($36.77) now slightly exceeds model overshoot ($34.78), and the
most expensive findings are turns where the model choice was *correct* and the
context carried was not. That is a claim the naive version of this project could
not have made: "you used Opus where Haiku would do" is what anyone would guess,
and it turns out to be the smaller half.

These are the figures the published snapshot carries; the demo and this file come
from the same export.

Only public, license-compliant data or the user's own exports are used. No
authentication is bypassed and no private repositories are accessed.

## Validation

**Status: the measurement is built and has not been run.** There is no classifier
accuracy figure yet — the classification cache is empty, so nothing in this
repository reports how well the classifier agrees with a human. Every waste
figure currently published comes from hand labels, stamped `hand-labelled` in the
payload. The methodology below is implemented and tested; what it lacks is a
result. Saying so is cheaper than being asked.

When it runs, classifier agreement is reported as **Cohen's kappa** alongside raw
percent agreement, and kappa is the figure that carries the claim: on a skewed
label mix, answering the most common class every time scores well on raw
agreement while learning nothing.

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
cd frontend && npm install && npm run test && npm run dev
```

The dashboard runs without the backend. Dropping a CSV on it exercises the whole
browser engine — parse, price, aggregate — with no server and no API key.

**Publishing a snapshot.** The deployed site is static, so it serves a frozen
export. Prompt text is redacted by default and an assertion fails the export if
any survives; the CI workflow re-checks before deploying.

```bash
uv run python -m tokenlens.snapshot ../frontend/public/snapshot.json \
  --labels ../labels.csv
```

Without `--labels` (or `$TOKENLENS_LABELS`) the export can only publish cached
classifier output, so a hand-labelled project would ship a dashboard with no
waste score at all — which is exactly what the published snapshot used to be.

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
- **The classifier is unmeasured.** Agreement machinery exists; no kappa has been
  computed. Until it is, the published waste figures rest on hand labels, and the
  claim "the classifier works" is not one this project can currently support.
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
backend/scripts/        fixture generators that keep the two engines in step
frontend/src/engine/    the same rules in TypeScript, for the browser path
  money.ts              exact decimal money as pico-dollar bigints
  csv.ts, csvIngest.ts  CSV reader + column semantics
  pricing.ts            cost engine, generated rate table
  score.ts, baseline.ts Waste Score + corpus baselines
  analysis.ts           the same payload, built client-side
  __fixtures__/         what Python computes, for the port to reproduce
frontend/src/components/ React dashboard + the upload and column-mapping flow
```

## Docs

- [PRD v2.1](Documents/TokenLens_PRD_v2.docx) — current
- [PRD v1.0](Documents/TokenLens_PRD.docx) — superseded, kept for history
