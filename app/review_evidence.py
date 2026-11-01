"""Deterministic evidence checks for reviewer findings.

These checks validate the *shape* of the evidence a finding supplies. They do
not, and cannot, decide whether the claim is true:

* a finding can cite a real line, name a real criterion, and still be wrong;
* a passing check is format compliance, not proof of a defect;
* a failing check means the finding cannot be acted on as a blocker, not that
  the code is correct.

They exist because unsupported blockers recurred with a small local model: a
reviewer rejected correct code (run_478959ca3d86, run_9038fdabb1b9) by
restating the acceptance criteria, and once by reporting a fabricated
expected/actual pair. The orchestrator uses this module to avoid dispatching a
revision for a blocker that carries no minimum evidence. It never turns an
unsubstantiated blocker into approval.

Only blocker findings can make a rejection invalid. Major, minor, and nit
findings are evaluated and reported, but they do not change routing yet.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from app.models import ReviewFinding, ReviewOutput

# An unquoted criterion must be at least this long to count when it merely
# appears inside a message; shorter text matches too much by accident. A
# criterion of any length counts when the finding quotes it exactly.
_MIN_CRITERION_CHARS = 15
_MIN_EXCERPT_WORDS = 3

_LINE_REF = re.compile(r"\blines?\s+\d+\b", re.IGNORECASE)
_FILE_LINE_REF = re.compile(r"\b[\w./\\-]+\.[A-Za-z0-9]{1,6}:\d+\b")
_BACKTICK = re.compile(r"`([^`\n]{2,})`")
_QUOTED = re.compile(r"[\"'`]([^\"'`\n]{2,})[\"'`]")
# Something expression-like inside backticks, e.g. `sorted(...)`, `x == y`, or
# `n = 0`. A path (`tests/test_target.py`) or a bare name (`normalize_tags`) must
# not qualify, so separators like `/`, `-`, and `*` are not enough on their own.
_EXPRESSION = re.compile(r"[()\[\]{}]|==|!=|<=|>=|->|(?<![=<>!])=(?!=)")
_RUNTIME_CLAIM = re.compile(
    r"\b(expected|actual|returns?|returned|output|outputs|raises?|raised|fails?|failed)\b",
    re.IGNORECASE,
)
_EXPECTED = re.compile(r"\bexpected\b", re.IGNORECASE)
_ACTUAL = re.compile(r"\bactual(?:ly)?\b", re.IGNORECASE)

# Phrasings that pair an expected outcome with an observed one, in addition to
# the literal words "expected" and "actual". Each pattern needs both halves
# inside one sentence; a full stop followed by whitespace ends the window, so a
# fix suggestion in the next sentence ("Use X instead of Y") does not count.
_WINDOW = r"(?:(?!\.\s)[^\n]){1,200}?"
_OBSERVED = r"(?:returns?|returned|produces?|produced|gives?|gave|yields?|outputs?|raises?|raised)"
_EXPECTED_ACTUAL_PHRASES = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        # "returns ['b', 'a'] instead of ['a', 'b']"
        rf"\b{_OBSERVED}\b{_WINDOW}\binstead of\b",
        # "instead of ['a', 'b'] it returns ['b', 'a']"
        rf"\binstead of\b{_WINDOW}\b{_OBSERVED}\b",
        # "should return ['a', 'b'] but returns ['b', 'a']"
        rf"\bshould\s+(?:return|be|produce|raise|yield|output|give)\b{_WINDOW}"
        rf"\bbut\b{_WINDOW}\b(?:{_OBSERVED}|got|is)\b",
        # "expected ['a', 'b'] but got ['b', 'a']" / "got ['b', 'a'], expected ..."
        rf"\bexpected\b{_WINDOW}\bgot\b",
        rf"\bgot\b{_WINDOW}\bexpected\b",
    )
)


def _normalise(text: str) -> str:
    return " ".join(text.lower().split()).strip(" .,\"'")


def _normalise_path(path: str) -> str:
    normalised = path.replace("\\", "/").strip()
    while normalised.startswith("./"):
        normalised = normalised[2:]
    return normalised


@dataclass(frozen=True)
class EvidenceCheck:
    """The evidence-shape assessment of a single finding."""

    finding: ReviewFinding
    has_code_reference: bool
    has_acceptance_criterion: bool
    has_relevant_file: bool
    claims_runtime_behaviour: bool
    has_expected_actual: bool

    @property
    def missing(self) -> tuple[str, ...]:
        gaps: list[str] = []
        if not self.has_code_reference:
            gaps.append("code reference or line")
        if not self.has_acceptance_criterion:
            gaps.append("named acceptance criterion")
        if not self.has_relevant_file:
            gaps.append("relevant workspace file")
        if self.claims_runtime_behaviour and not self.has_expected_actual:
            gaps.append("expected/actual behaviour")
        return tuple(gaps)

    @property
    def is_supported(self) -> bool:
        """Format compliance only. True does not mean the finding is correct."""
        return not self.missing


@dataclass(frozen=True)
class ReviewEvidenceReport:
    checks: tuple[EvidenceCheck, ...]

    @property
    def unsupported_blockers(self) -> tuple[EvidenceCheck, ...]:
        return tuple(
            check
            for check in self.checks
            if check.finding.severity == "blocker" and not check.is_supported
        )

    @property
    def supported_findings(self) -> tuple[EvidenceCheck, ...]:
        return tuple(check for check in self.checks if check.is_supported)

    @property
    def is_invalid_rejection(self) -> bool:
        """A rejection that rests on nothing but unsubstantiated blockers.

        An invalid rejection must never become approval, and it must not trigger
        a coding revision, because there is no actionable evidence to act on.
        """
        return bool(self.unsupported_blockers) and not self.supported_findings


def evaluate_finding(
    finding: ReviewFinding,
    *,
    acceptance_criteria: Iterable[str] = (),
    files: Mapping[str, str] | None = None,
) -> EvidenceCheck:
    message = finding.message or ""
    criteria = [criterion for criterion in acceptance_criteria if criterion]
    known_files = {_normalise_path(path) for path in files or {}}
    # A quoted criterion is the reviewer citing the plan, not a claim about
    # runtime behaviour: "the returned list is sorted" must not, by itself,
    # demand an expected/actual pair.
    claim = _without_cited_criteria(message, criteria)

    return EvidenceCheck(
        finding=finding,
        has_code_reference=_has_code_reference(message),
        has_acceptance_criterion=_has_acceptance_criterion(message, criteria),
        has_relevant_file=(
            finding.file is None
            or not known_files
            or _normalise_path(finding.file) in known_files
        ),
        claims_runtime_behaviour=bool(_RUNTIME_CLAIM.search(claim)),
        has_expected_actual=_has_expected_actual(claim),
    )


def validate_review(
    review: ReviewOutput,
    *,
    acceptance_criteria: Iterable[str] = (),
    files: Mapping[str, str] | None = None,
) -> ReviewEvidenceReport:
    criteria = list(acceptance_criteria)
    return ReviewEvidenceReport(
        checks=tuple(
            evaluate_finding(finding, acceptance_criteria=criteria, files=files)
            for finding in review.findings
        )
    )


def _has_code_reference(message: str) -> bool:
    if _LINE_REF.search(message) or _FILE_LINE_REF.search(message):
        return True
    for span in _BACKTICK.findall(message):
        # A bare path (`target.py`) or a bare identifier (`normalize_tags`) is
        # not a code reference; require something expression-like.
        if _EXPRESSION.search(span):
            return True
    return False


def _has_acceptance_criterion(message: str, criteria: list[str]) -> bool:
    normalised_message = _normalise(message)
    normalised_criteria = [_normalise(criterion) for criterion in criteria]
    for candidate in normalised_criteria:
        if len(candidate) >= _MIN_CRITERION_CHARS and candidate in normalised_message:
            return True
    return any(
        _cites_criterion(_normalise(span), normalised_criteria)
        for span in _QUOTED.findall(message)
    )


def _cites_criterion(quoted: str, normalised_criteria: list[str]) -> bool:
    if not quoted:
        return False
    # An exact quote names the criterion, however short it is.
    if quoted in normalised_criteria:
        return True
    # A phrase-length excerpt of a criterion also names it. A quoted value ('a')
    # or a quoted path (`tests/test_target.py`) that happens to occur inside a
    # criterion must not, or almost any message would cite one.
    return (
        len(quoted) >= _MIN_CRITERION_CHARS
        and len(quoted.split()) >= _MIN_EXCERPT_WORDS
        and any(quoted in candidate for candidate in normalised_criteria)
    )


def _has_expected_actual(text: str) -> bool:
    if _EXPECTED.search(text) and _ACTUAL.search(text):
        return True
    return any(pattern.search(text) for pattern in _EXPECTED_ACTUAL_PHRASES)


def _without_cited_criteria(message: str, criteria: list[str]) -> str:
    """Return the message with quoted or verbatim criterion text removed."""
    text = message
    normalised_criteria = [_normalise(criterion) for criterion in criteria]
    for span in _QUOTED.findall(message):
        if _cites_criterion(_normalise(span), normalised_criteria):
            text = text.replace(span, " ")
    lowered = " ".join(text.split())
    for criterion in criteria:
        candidate = " ".join(criterion.split())
        if len(candidate) >= _MIN_CRITERION_CHARS:
            lowered = re.sub(re.escape(candidate), " ", lowered, flags=re.IGNORECASE)
    return lowered
