"""Classification cache.

Classification is the only part of the pipeline that costs money, so re-running
an analysis must not re-pay for prompts already seen. Keys are content hashes,
which means the cache survives re-ingestion, reordering, and turn-id changes.

The prompt template version is part of the key. Editing the classifier's
instructions changes what the model is being asked, so old answers must not be
served for the new question — a subtle way to poison a validation run.
"""

from __future__ import annotations

import hashlib
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from tokenlens.classify.schema import Category, Classification, Complexity

_SCHEMA = """
CREATE TABLE IF NOT EXISTS classifications (
    key              TEXT PRIMARY KEY,
    prompt_sha       TEXT NOT NULL,
    prompt_version   TEXT NOT NULL,
    category         TEXT NOT NULL,
    complexity       TEXT NOT NULL,
    confidence       REAL NOT NULL,
    rationale        TEXT NOT NULL,
    model            TEXT NOT NULL,
    escalated        INTEGER NOT NULL,
    base_category    TEXT,
    base_complexity  TEXT,
    base_confidence  REAL,
    created_at       TEXT NOT NULL
);
"""


def cache_key(prompt_text: str, prompt_version: str, model: str) -> str:
    """Stable identity for one classification question.

    Includes the model because a Haiku answer and a Sonnet answer to the same
    prompt are different data points, and validation needs to tell them apart.
    """
    digest = hashlib.sha256(
        "\x00".join((prompt_text, prompt_version, model)).encode("utf-8")
    )
    return digest.hexdigest()


def prompt_sha(prompt_text: str) -> str:
    return hashlib.sha256(prompt_text.encode("utf-8")).hexdigest()


class ClassificationCache:
    """SQLite-backed store of classification results."""

    def __init__(self, path: Path | str = ":memory:"):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False so a future FastAPI worker can share one cache.
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with closing(self._conn.cursor()) as cur:
            cur.executescript(_SCHEMA)
        self._conn.commit()

    def get(self, key: str) -> Classification | None:
        with closing(self._conn.cursor()) as cur:
            cur.execute("SELECT * FROM classifications WHERE key = ?", (key,))
            row = cur.fetchone()
        return _from_row(row) if row else None

    def put(self, key: str, prompt_text: str, prompt_version: str, result: Classification) -> None:
        with closing(self._conn.cursor()) as cur:
            cur.execute(
                """
                INSERT OR REPLACE INTO classifications (
                    key, prompt_sha, prompt_version, category, complexity,
                    confidence, rationale, model, escalated,
                    base_category, base_complexity, base_confidence, created_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    key,
                    prompt_sha(prompt_text),
                    prompt_version,
                    result.category.value,
                    result.complexity.value,
                    result.confidence,
                    result.rationale,
                    result.model,
                    int(result.escalated),
                    result.base_category.value if result.base_category else None,
                    result.base_complexity.value if result.base_complexity else None,
                    result.base_confidence,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
        self._conn.commit()

    def __len__(self) -> int:
        with closing(self._conn.cursor()) as cur:
            cur.execute("SELECT COUNT(*) FROM classifications")
            return int(cur.fetchone()[0])

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> ClassificationCache:
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def _from_row(row: sqlite3.Row) -> Classification:
    return Classification(
        category=Category(row["category"]),
        complexity=Complexity(row["complexity"]),
        confidence=row["confidence"],
        rationale=row["rationale"],
        model=row["model"],
        escalated=bool(row["escalated"]),
        base_category=Category(row["base_category"]) if row["base_category"] else None,
        base_complexity=(
            Complexity(row["base_complexity"]) if row["base_complexity"] else None
        ),
        base_confidence=row["base_confidence"],
    )
