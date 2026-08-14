/**
 * A prompt the visitor can paste into ChatGPT, Claude or Gemini to get a CSV
 * this tool can read.
 *
 * It is a **converter**, and deliberately not a generator. A chat model cannot
 * see anyone's billing data, so "write me a CSV of my token usage" produces
 * invented rows that look entirely plausible — and TokenLens would then price
 * them and report a waste score on fiction. That is the one thing this project
 * exists not to do. So the prompt takes an export the person already has and
 * reshapes it, and spends several of its lines forbidding the model to fill a
 * gap with a reasonable-looking number.
 *
 * The header is `CANONICAL_HEADER`, so what the prompt asks for and what the
 * parser detects cannot drift apart.
 */

import { CANONICAL_HEADER } from '../engine/csvIngest'

export const CSV_PROMPT = `I have an export of my AI API usage. Convert it into a CSV for TokenLens, which prices the spend and scores how much of it was avoidable.

Use exactly this header, in this order:

${CANONICAL_HEADER.join(',')}

One row per API request — not one per conversation.

What each column means:
- model — required. The exact model id as billed, e.g. claude-sonnet-5, gpt-4o-mini. Do not shorten, prettify, or guess a version.
- timestamp — ISO 8601, e.g. 2026-08-12T09:14:02Z. Empty if the export has no time.
- input_tokens — tokens charged as fresh input, EXCLUDING anything served from cache. If my export folds cached tokens into its input or prompt total, subtract them here and tell me you did.
- output_tokens — completion tokens.
- cache_read — tokens served from a cache.
- cache_write_5m, cache_write_1h — tokens written to a cache, split by time-to-live. If my export does not split them, put the whole figure in cache_write_5m and say so afterwards.
- turn_id — groups the requests that came from one prompt of mine. A trace, conversation, or request-group id is ideal. Empty if there is nothing to group by.
- session_id — optional.
- prompt — my prompt text, only if the export actually contains it.

Rules, in order of importance:
1. Use only what is in the data I give you.
2. Never estimate, infer, or invent a number, and never fill an empty cell with a plausible one. An empty cell is correct and safe; a guessed one silently corrupts every cost figure downstream.
3. Do not add, merge, or drop rows.
4. If you cannot tell what a column should be, leave it empty and say why afterwards.
5. Reply with the CSV only — no commentary, no markdown code fence — followed by a short note if any assumption was needed.

Here is my export:`
