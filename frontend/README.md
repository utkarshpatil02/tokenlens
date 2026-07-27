# TokenLens dashboard

React + Vite frontend for the TokenLens analysis API.

## Requirements

Node **20.19+** or **22.12+**. The Vite 8 toolchain declares this in `engines`,
and on an older Node npm silently skips rolldown's platform-specific native
binding as incompatible: the install reports success and the build then fails
with `MODULE_NOT_FOUND` for `@rolldown/binding-*`. If that happens, check
`node --version` before anything else.

## Running

Start the backend first:

```bash
cd ../backend && uv run uvicorn tokenlens.api:app --port 8000
```

Then:

```bash
npm install
npm run dev
```

Vite proxies `/api` to `127.0.0.1:8000` (see `vite.config.ts`), so the app uses
same-origin relative URLs and needs no environment-specific base URL.

## Notes

Money arrives from the API as exact decimal strings rather than JSON numbers.
`format.ts` converts to a float only for display; storing the float back would
discard precision the backend preserves deliberately.

Charts are CSS bars and a table-based heatmap rather than a charting library. The
shares in the token-category view span three orders of magnitude — uncached input
is ~0.0% of spend, and that near-zero row is the finding, so it has to stay
legible — which rules out a pie chart and needs no plotting engine. A charting
dependency can be added if a time-series view arrives.

The waste section renders only when classifications exist. It is absent rather
than zeroed, because zeros would read as "no waste found" when the truth is "not
yet measured".
