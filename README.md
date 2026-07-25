# TokenLens

**AI usage monitoring & waste intelligence platform.**

TokenLens ingests API usage logs, classifies what people are actually using AI for, estimates what each task *should* have cost, and scores the gap.

Observability platforms (Helicone, Langfuse, LiteLLM) report what you spent. TokenLens estimates what you should have spent and quantifies the difference. That's a judgment layer, not a reporting layer — and it's the entire contribution of this project.

> **Status:** Pre-build. This README is generated from the [PRD](Documents/TokenLens_PRD_v2.docx) and will be rewritten to reflect the actual implementation as code lands.

## The Problem

Token-metered pricing means AI cost scales with usage in ways that are invisible until the invoice arrives:

- A verbose or poorly structured prompt can cost many times more than a tight one for the same result.
- Users default to the most capable (most expensive) model regardless of task difficulty.
- No feedback loop exists between the vendor invoice and individual usage behaviour.

Organisations can see the total spend; they can't see the composition — which of it was valuable, and which was waste.

**Scope honesty:** headline AI-overspend incidents (e.g. unlimited seat licenses) are a different failure mode from per-call token waste. TokenLens addresses the question that comes *after* a spend cap is in place: given a fixed budget, which of this spend was worth it?

## Approach

1. **Ingest** API usage logs (JSON/CSV) — model, tokens, timestamp, optional prompt text and user id.
2. **Classify** each prompt on two independent axes via Claude Haiku: task **category** (coding, research, writing, summarization, busywork) and task **complexity** (trivial / moderate / complex), which maps to a required model tier.
3. **Score** each prompt with a bounded, additive **Waste Score**:

   ```
   waste_score = 45·overshoot + 35·bloat + 20·zero_value      → 0–100
   ```

   - **overshoot** — using a more expensive model than the task required.
   - **bloat** — prompt length beyond what the task type warrants (vs. a median-token lookup).
   - **zero_value** — binary flag for busywork tasks where LLM use isn't justified at any tier.

4. **Present** a dashboard: spend overview, cost breakdown, a complexity-vs-model heatmap, a waste leaderboard with per-prompt rationale, and a savings estimate.

See the PRD (§5.3) for the full worked example and the design rationale for the weights.

## Data Strategy

Real prompt text comes from public research datasets (WildChat, LMSYS-Chat-1M) so classification runs on genuine user language rather than invented examples. Model selection, timestamps, pricing, and usage patterns are a **synthetic layer calibrated against observed distributions** — no public dataset contains real per-call cost/model data at this granularity. Synthetic-derived figures are visually marked in the UI. PII is stripped before analysis.

Team/department analytics were deliberately cut — no public data source contains organisational structure, and fabricating it would undermine the rest of the dashboard.

## Validation

A project claiming to score waste needs an answer to "how do you know it works":

- 100 hand-labelled prompts (category + complexity), with a human-agreement baseline from independent labellers on a subset.
- Classifier agreement reported per axis, plus a confusion matrix and named failure modes — not just an accuracy number.
- Score sanity checks: no record scores non-zero purely from being under-provisioned, and a verbose prompt on a correct model still registers bloat.

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React + Recharts |
| Backend | Python + FastAPI |
| Classifier | Claude Haiku |
| Storage | SQLite |
| Hosting | Vercel + Railway |

## Non-Goals

Not a production SaaS product. No live API proxy or traffic interception. No multi-tenant auth/RBAC/SSO. No ROI attribution against external HR/PM systems. No team/department analytics (see Data Strategy).

## Roadmap

| Week | Deliverable |
|---|---|
| 1 | Synthetic generator + ingestion pipeline, end-to-end on fake data |
| 2 | Classifier (category + complexity) via Haiku, with caching; real prompts swapped in |
| 3 | Waste Score implementation with unit tests |
| 4 | Dashboard: overview, breakdown, heatmap, leaderboard, savings estimate |
| 5 | Validation run, README, demo video, deploy |

## Docs

- [Product Requirements Document v2.0](Documents/TokenLens_PRD_v2.docx) — current
- [Product Requirements Document v1.0](Documents/TokenLens_PRD.docx) — superseded, kept for history
