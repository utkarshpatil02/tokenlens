"""HTTP API for the dashboard.

    uv run uvicorn tokenlens.api:app --reload

Reads local Claude Code logs on each request. Analysis is fast enough (~150
requests over a handful of files) that caching would add staleness for no real
gain, and a live read means the dashboard reflects work done since it was opened.

Classification is never triggered by a page load. `GET /api/analysis` serves
whatever is already cached; issuing new, billable classification requests
requires an explicit `POST /api/classify`.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from tokenlens import __version__
from tokenlens.analysis import build_analysis
from tokenlens.classify_cli import DEFAULT_CACHE
from tokenlens.report import DEFAULT_PROJECTS

# Overridable so the dashboard can be pointed at an exported log directory
# rather than only the machine's own history.
PROJECTS_PATH = Path(os.getenv("TOKENLENS_PROJECTS", DEFAULT_PROJECTS))
CACHE_PATH = Path(os.getenv("TOKENLENS_CACHE", DEFAULT_CACHE))

app = FastAPI(title="TokenLens", version=__version__)

# The Vite dev server runs on a different origin during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    """Whether there is anything to analyse, and whether waste can be scored."""
    return {
        "status": "ok",
        "version": __version__,
        "projects_path": str(PROJECTS_PATH),
        "projects_path_exists": PROJECTS_PATH.exists(),
        "cache_path": str(CACHE_PATH),
        "has_api_key": bool(os.getenv("ANTHROPIC_API_KEY")),
    }


@app.get("/api/analysis")
def analysis() -> dict:
    """Spend analysis, plus waste analysis for any already-classified prompts."""
    return _build(classify=False)


@app.post("/api/classify")
def classify() -> dict:
    """Classify uncached prompts, then return the full analysis.

    Billable, so it is a POST and never happens on a page load.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise HTTPException(
            status_code=400,
            detail=(
                "ANTHROPIC_API_KEY is not set, so prompts cannot be classified. "
                "Set it and retry, or use GET /api/analysis for spend analysis only."
            ),
        )
    return _build(classify=True)


def _build(classify: bool) -> dict:
    if not PROJECTS_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail=(
                f"No log directory at {PROJECTS_PATH}. Set TOKENLENS_PROJECTS to "
                "point at a Claude Code projects directory."
            ),
        )
    return build_analysis(
        PROJECTS_PATH, cache_path=CACHE_PATH, classify=classify
    ).to_payload()
