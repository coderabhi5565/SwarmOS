"""What the public demo may show of a run.

Runs and traces are stored exactly as they were recorded, so an operator in
``local`` mode keeps every detail for debugging. In ``public_demo`` mode each
response that carries run data passes through :class:`PublicRedactor` first:
the run detail, the polled events, the live stream, the run list, and the
benchmark views' free text. Nothing stored is changed, so traces recorded
before this existed are just as safe when read.

The public representation:

* **Commands** (every ``command`` field: the command recorded when
  verification starts, and the command line a verification result says it
  executed) are an allowlist: only the server's configured verification
  command (e.g. ``python -m pytest -q``) is shown; anything else, such as
  the absolute interpreter and sandbox-launcher command line actually
  executed, becomes ``[redacted]``.
* **Output tails** cut at the recording limit lose their first, partial
  line, which could start part-way through a path.
* **Every other string**, at any depth (dict keys included), has these
  removed: the configured key, endpoint URL and endpoint host; credential-
  like tokens and ``NAME_KEY=value`` assignments; URLs; Windows, UNC, POSIX
  and home-relative absolute paths (repr-escaped ones too); IP addresses.
  A path inside a run's temporary workspace keeps only its workspace-
  relative part (``tests/test_target.py``), which says nothing about the host.

Identifiers, statuses, counts, timings, sequence numbers and relationships
are untouched, and no event is ever dropped.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from app.config import Settings
from app.models import RunDetail, RunRecord, TraceEvent

REDACTED = "[redacted]"
REDACTED_PATH = "[redacted path]"
REDACTED_ADDRESS = "[redacted address]"

# The length at which app.runtime.workspace._tail cuts output (keeping the end).
TAIL_LIMIT = 4000
_TAIL_FIELDS = frozenset({"stdout_tail", "stderr_tail"})
_EXECUTED_COMMAND = "command"
# A configured secret shorter than this is not replaced: it would match
# ordinary words (an empty key, a placeholder like "x").
_MIN_SECRET = 6

_URL = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://\S+")
_CREDENTIAL = re.compile(
    r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"
    r"|\bgh[pousr]_[A-Za-z0-9]{20,}"
    r"|\bgithub_pat_[A-Za-z0-9_]{20,}"
    r"|\bAKIA[0-9A-Z]{16}\b"
    r"|\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}"
)
_ASSIGNMENT = re.compile(
    r"\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*)"
    r"(\s*[=:]\s*)\S+"
)

_SEP = r"[\\/]+"  # one or more: repr() doubles backslashes
_DIR = r"""[^\\/\r\n"'<>|*?:]+"""  # a directory name; may contain spaces
_NAME = r"""[^\\/\s"'<>|*?:,;)\]]*"""  # the last name, up to whitespace or punctuation
_WINDOWS_PATH = re.compile(
    rf"""(?<![\w\\/])(?:[A-Za-z]:|\\\\[^\\/\s"'<>|]+){_SEP}(?:{_DIR}{_SEP})*{_NAME}"""
)
_POSIX_PATH = re.compile(
    r"""(?<![\w.:/\\~-])~?/(?:[^/\r\n"'<>|*?:]+/+)*[^/\s"'<>|*?:,;)\]]+"""
)
# app.runtime.workspace: Workspace.create_temp(prefix="swarmos-<run_id>-") / "workspace"
_WORKSPACE = re.compile(rf"""swarmos-[^\\/\s"'<>|]*{_SEP}workspace(?:{_SEP}|$)""")
_IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w.])")
_IPV6 = re.compile(r"\[[0-9A-Fa-f]*:[0-9A-Fa-f:]*:[0-9A-Fa-f]*\](?::\d{1,5})?")


def _path(match: re.Match[str]) -> str:
    """An absolute path, as the public may see it."""
    path = match.group(0)
    inside = _WORKSPACE.search(path)
    if inside is None:
        return REDACTED_PATH
    relative = re.sub(_SEP, "/", path[inside.end() :])
    return relative or "."


def _untruncated(tail: str) -> str:
    """A tail cut at the limit may begin inside a path: drop its first line."""
    if len(tail) < TAIL_LIMIT:
        return tail
    _, newline, rest = tail.partition("\n")
    return f"[earlier output omitted]\n{rest}" if newline else "[earlier output omitted]"


class PublicRedactor:
    """The public representation of run data, for one server's settings."""

    def __init__(self, settings: Settings) -> None:
        secrets = {settings.api_key, settings.base_url}
        if settings.base_url:
            endpoint = urlparse(settings.base_url)
            secrets |= {endpoint.netloc, endpoint.hostname or ""}
        # Longest first, so a URL is replaced whole before its host.
        self._secrets = sorted(
            (secret for secret in secrets if len(secret) >= _MIN_SECRET),
            key=len,
            reverse=True,
        )
        self._command = settings.verification_command.strip()

    # ------------------------------------------------------------------
    # text
    # ------------------------------------------------------------------
    def text(self, text: str) -> str:
        """Free text with every private detail replaced."""
        for secret in self._secrets:
            text = text.replace(secret, REDACTED)
        text = _CREDENTIAL.sub(REDACTED, text)
        text = _ASSIGNMENT.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)
        text = _URL.sub(REDACTED, text)
        text = _WINDOWS_PATH.sub(_path, text)
        text = _POSIX_PATH.sub(_path, text)
        text = _IPV6.sub(REDACTED_ADDRESS, text)
        return _IPV4.sub(REDACTED_ADDRESS, text)

    def command(self, command: str) -> str:
        """A ``command`` field: shown only when it is the configured verification command."""
        return self.text(command) if command.strip() == self._command else REDACTED

    def value(self, value: Any, key: str | None = None) -> Any:
        """Any JSON-like value, recursively; ``key`` is the field it sits in."""
        if isinstance(value, str):
            if key == _EXECUTED_COMMAND:
                return self.command(value)
            if key in _TAIL_FIELDS:
                value = _untruncated(value)
            return self.text(value)
        if isinstance(value, dict):
            return {
                (self.text(k) if isinstance(k, str) else k): self.value(
                    v, k if isinstance(k, str) else None
                )
                for k, v in value.items()
            }
        if isinstance(value, (list, tuple)):
            return [self.value(item, key) for item in value]
        return value

    # ------------------------------------------------------------------
    # run data
    # ------------------------------------------------------------------
    def event(self, event: TraceEvent) -> TraceEvent:
        """One trace event; its id, run, seq, time and kind are unchanged."""
        return event.model_copy(
            update={"message": self.text(event.message), "payload": self.value(event.payload)}
        )

    def run(self, record: RunRecord) -> RunRecord:
        return RunRecord.model_validate(self.value(record.model_dump(mode="json")))

    def detail(self, detail: RunDetail) -> RunDetail:
        return RunDetail(run=self.run(detail.run), events=[self.event(e) for e in detail.events])
