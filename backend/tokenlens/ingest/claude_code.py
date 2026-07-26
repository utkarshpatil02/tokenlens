"""Claude Code session log ingestion.

Claude Code writes one JSONL file per session under
`~/.claude/projects/<slug>/<session-id>.jsonl`. This is the project's real-data
source: genuine per-request model, token, and timestamp values for work that
actually happened.

The format is agentic, which shapes the whole adapter. One user prompt produces
many billable calls — in the reference data the mean is 6.9 and the maximum 26 —
so calls have to be grouped back under the prompt that caused them before
anything can be scored per prompt. Assistant records carry no prompt id, only a
`parentUuid`, so grouping walks that chain up to the nearest record that has one.

Records whose turn cannot be resolved are kept in a synthetic turn rather than
dropped: they are real spend, and losing them would understate the total with no
visible symptom.

Two forms of duplication have to be removed or spend is overstated by roughly
2x, and both were found in the reference data rather than anticipated:

* One assistant response is written as several records, one per content block
  (thinking, text, tool_use, ...). Every record repeats the *same* `message.id`
  and the *same* usage object, because that usage bills the whole response and
  not the individual block. In the reference file, 156 usage-carrying records
  represented only 78 distinct API requests.
* A resumed session copies the earlier session's history into its new file, so
  the same requests appear again under a different session id. Two files in the
  reference data shared 77 request ids.

Both are handled by deduplicating on `message.id`, globally rather than per
file, so a resumed session does not re-bill history it inherited.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

from tokenlens.models import Call, Profile, Turn

# Records that inject text into the transcript rather than representing
# something the user typed: slash-command wrappers, system reminders, hook
# output, skill preambles. They are prompt-shaped but not prompts, and
# classifying them would pollute the category distribution.
_INJECTED_PREFIX_SCAN = 60

# How far to walk up a parentUuid chain before giving up. Chains are short in
# practice; the bound just prevents a malformed file from hanging the parser.
_MAX_PARENT_WALK = 500


def parse_session(
    path: Path | str, seen_message_ids: set[str] | None = None
) -> list[Turn]:
    """Parse one session JSONL file into turns.

    `seen_message_ids` carries deduplication state across files. Pass a shared
    set when reading several sessions so a resumed session does not re-bill the
    history it copied from its predecessor.
    """
    records = list(_iter_records(path))
    session_id = _session_id(records, path)
    seen = seen_message_ids if seen_message_ids is not None else set()

    by_uuid = {r["uuid"]: r for r in records if "uuid" in r}
    prompts: dict[str, str] = {}
    calls: dict[str, list[Call]] = {}
    order: list[str] = []

    for record in records:
        kind = record.get("type")

        if kind == "user":
            prompt_id = record.get("promptId")
            if not prompt_id:
                continue
            text = _prompt_text(record)
            # Keep the first real prompt per id; later user records under the
            # same id are tool results or follow-on injected content.
            if text and prompt_id not in prompts:
                prompts[prompt_id] = text
                if prompt_id not in order:
                    order.append(prompt_id)

        elif kind == "assistant":
            call = _extract_call(record)
            if call is None:
                continue

            billing_id = _billing_id(record)
            if billing_id is not None:
                if billing_id in seen:
                    continue
                seen.add(billing_id)

            turn_key = _resolve_prompt_id(record, by_uuid) or f"unattributed:{session_id}"
            if turn_key not in calls:
                calls[turn_key] = []
                if turn_key not in order:
                    order.append(turn_key)
            calls[turn_key].append(call)

    turns: list[Turn] = []
    for turn_key in order:
        turn_calls = calls.get(turn_key, [])
        prompt = prompts.get(turn_key)
        # A prompt with no calls produced no spend and nothing to score.
        if not turn_calls:
            continue
        turns.append(
            Turn(
                turn_id=f"{session_id}:{turn_key}",
                profile=Profile.AGENTIC,
                timestamp=min(c.timestamp for c in turn_calls),
                calls=turn_calls,
                prompt_text=prompt,
                session_id=session_id,
            )
        )
    return turns


def parse_projects(root: Path | str) -> list[Turn]:
    """Parse every session under a Claude Code projects directory.

    Deduplication is shared across files. Files are read oldest-first so that
    when a resumed session has copied history forward, the requests are credited
    to the session that originally made them.
    """
    root = Path(root).expanduser()
    paths = sorted(root.rglob("*.jsonl"), key=lambda p: (p.stat().st_mtime, p.name))
    seen: set[str] = set()
    turns: list[Turn] = []
    for path in paths:
        turns.extend(parse_session(path, seen_message_ids=seen))
    return turns


def _iter_records(path: Path | str) -> Iterator[dict]:
    """Yield parsed records, skipping malformed lines.

    A single truncated line — common if a session is still being written — must
    not cost us the rest of the file.
    """
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                yield record


def _session_id(records: list[dict], path: Path | str) -> str:
    for record in records:
        if record.get("sessionId"):
            return record["sessionId"]
    return Path(path).stem


def _extract_call(record: dict) -> Call | None:
    """Build a Call from an assistant record, or None if it is not billable."""
    message = record.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    model = message.get("model")
    timestamp = _parse_timestamp(record.get("timestamp"))
    if not model or timestamp is None:
        return None

    # Cache writes are split by TTL because the two tiers price differently
    # (1h at 2x base input, 5m at 1.25x). Older logs may report only the
    # aggregate, in which case attribute it to the 5m tier — the cheaper of the
    # two, so an unknown TTL never inflates the reported figure.
    creation = usage.get("cache_creation")
    if isinstance(creation, dict):
        write_5m = int(creation.get("ephemeral_5m_input_tokens", 0) or 0)
        write_1h = int(creation.get("ephemeral_1h_input_tokens", 0) or 0)
    else:
        write_5m = int(usage.get("cache_creation_input_tokens", 0) or 0)
        write_1h = 0

    return Call(
        model=model,
        timestamp=timestamp,
        input_tokens=int(usage.get("input_tokens", 0) or 0),
        output_tokens=int(usage.get("output_tokens", 0) or 0),
        cache_read=int(usage.get("cache_read_input_tokens", 0) or 0),
        cache_write_5m=write_5m,
        cache_write_1h=write_1h,
    )


def _billing_id(record: dict) -> str | None:
    """Identity of the API request this record reports usage for.

    `message.id` is preferred because it is stable across the several records
    that one response is split into, and across a resumed session's copied
    history. `requestId` is the fallback. When neither is present the record
    cannot be deduplicated, and is counted rather than discarded — overstating a
    call is recoverable, silently dropping real spend is not.
    """
    message = record.get("message")
    if isinstance(message, dict) and message.get("id"):
        return f"msg:{message['id']}"
    if record.get("requestId"):
        return f"req:{record['requestId']}"
    return None


def _resolve_prompt_id(record: dict, by_uuid: dict[str, dict]) -> str | None:
    """Walk parentUuid up to the nearest record carrying a promptId."""
    current = record
    for _ in range(_MAX_PARENT_WALK):
        prompt_id = current.get("promptId")
        if prompt_id:
            return prompt_id
        parent = current.get("parentUuid")
        if not parent or parent not in by_uuid:
            return None
        current = by_uuid[parent]
    return None


def _prompt_text(record: dict) -> str | None:
    """Extract what the user actually typed, or None.

    Returns None for tool results, harness-injected content, and empty text.
    """
    if record.get("isMeta") or record.get("toolUseResult"):
        return None

    message = record.get("message")
    if not isinstance(message, dict):
        return None

    content = message.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        # A tool_result anywhere marks this as harness traffic, not a prompt.
        if any(
            isinstance(block, dict) and block.get("type") == "tool_result"
            for block in content
        ):
            return None
        text = " ".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    else:
        return None

    text = text.strip()
    if not text or _is_injected(text):
        return None
    return text


def _is_injected(text: str) -> bool:
    """Whether text is a harness wrapper rather than a user prompt.

    Injected content is XML-tagged (`<command-name>`, `<system-reminder>`,
    `<local-command-caveat>`, and similar). Requiring a closing angle bracket
    near the start keeps a prompt that merely begins with a comparison or a
    generic from being discarded.
    """
    return text.startswith("<") and ">" in text[:_INJECTED_PREFIX_SCAN]


def _parse_timestamp(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
