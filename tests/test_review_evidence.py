"""Unit tests for the deterministic reviewer evidence guard.

The guard checks evidence *shape* only. These tests pin what it accepts and
rejects, replay the reviewer findings recorded in three real local-model runs,
and document the limits of a shape check.
"""

from __future__ import annotations

import pytest

from app.demo_tasks import SAMPLE_PLAN
from app.models import ReviewFinding, ReviewOutput
from app.review_evidence import evaluate_finding, validate_review

CRITERIA = [c for step in SAMPLE_PLAN.steps for c in step.acceptance_criteria]
FILES = {"README.md": "", "target.py": "", "tests/test_target.py": ""}
SORTED_CRITERION = "the returned list is sorted ascending, not merely deduplicated"


def check(message: str, *, severity: str = "blocker", file: str | None = "target.py",
          criteria=CRITERIA, files=FILES):
    finding = ReviewFinding(severity=severity, file=file, message=message)
    return evaluate_finding(finding, acceptance_criteria=criteria, files=files)


def report(*findings: dict, criteria=CRITERIA, files=FILES):
    review = ReviewOutput(verdict="request_changes", findings=list(findings))
    return validate_review(review, acceptance_criteria=criteria, files=files)


# A blocker that carries every kind of evidence the guard looks for.
GOOD_BLOCKER = (
    f'target.py:6 `return list(set(cleaned))` violates "{SORTED_CRITERION}": '
    'normalize_tags(["b", "a"]) is expected to return ["a", "b"], '
    'but the actual result is ["b", "a"].'
)


def test_fully_evidenced_blocker_is_supported():
    result = check(GOOD_BLOCKER)
    assert result.is_supported
    assert result.missing == ()


# ----------------------------------------------------------------------
# historical incidents (messages copied from the stored traces)
# ----------------------------------------------------------------------
INCIDENT_BLOCKERS = {
    # run_32c8ea28b288, review 1: the code really lacked sorting, but the
    # finding named no line and no criterion.
    "run_32c8ea28b288": "The function `normalize_tags` does not implement the "
    "required functionality.",
    # run_478959ca3d86, review 2: correct code, criteria restated as a blocker.
    "run_478959ca3d86": "The function `normalize_tags` does not trim whitespace, "
    "lowercase, drop empty entries, deduplicate, and sort ascending. The current "
    "implementation does not match these requirements.",
    # run_9038fdabb1b9, review 1: correct code, fabricated expected/actual pair.
    "run_9038fdabb1b9/1": 'The function does not sort the list correctly. The '
    'expected output is ["fastapi", "python"], but the actual output is '
    '["python", "fastapi"].',
    # run_9038fdabb1b9, review 2: correct code, generic restatement.
    "run_9038fdabb1b9/2": "The implementation in `target.py` does not pass the "
    "acceptance criteria. The tests in `tests/test_target.py` expect the "
    "`normalize_tags` function to trim whitespace, lowercase, drop empty entries, "
    "deduplicate, and sort ascending. However, the current implementation does "
    "not meet these expectations.",
}


@pytest.mark.parametrize("incident", sorted(INCIDENT_BLOCKERS))
def test_historical_unsupported_blockers_make_the_rejection_invalid(incident):
    result = report(
        {
            "severity": "blocker",
            "step_id": "draft_implementation",
            "file": "target.py",
            "message": INCIDENT_BLOCKERS[incident],
        }
    )
    assert result.is_invalid_rejection
    (blocker,) = result.unsupported_blockers
    assert "code reference or line" in blocker.missing
    assert "named acceptance criterion" in blocker.missing


def test_fabricated_expected_actual_pair_alone_is_not_enough():
    # run_9038fdabb1b9 round 1 had an expected/actual pair but nothing else.
    result = check(INCIDENT_BLOCKERS["run_9038fdabb1b9/1"])
    assert result.has_expected_actual
    assert not result.is_supported


def test_run_32c8_second_review_minor_findings_do_not_trigger_the_guard():
    # Only blockers are validated for now: minor findings still revise.
    result = report(
        {
            "severity": "minor",
            "step_id": "draft_implementation",
            "file": "target.py",
            "message": "The `normalize_tags` function does not handle empty lists "
            "correctly. It should return an empty list if the input list is empty.",
        },
        {
            "severity": "minor",
            "step_id": "draft_implementation",
            "file": "tests/test_target.py",
            "message": "The tests do not cover the case where the input list "
            "contains only whitespace.",
        },
    )
    assert result.unsupported_blockers == ()
    assert not result.is_invalid_rejection


# ----------------------------------------------------------------------
# code references
# ----------------------------------------------------------------------
@pytest.mark.parametrize(
    "fragment",
    [
        "line 6",
        "Line 6",
        "lines 6",
        "target.py:6",
        "tests/test_target.py:12",
        "`sorted(tags)`",
        "`x == y`",
        "`n = 0`",
        "`tags[0]`",
        "`-> list[str]`",
    ],
)
def test_code_reference_forms_are_recognised(fragment):
    assert check(f'{fragment} violates "{SORTED_CRITERION}".').has_code_reference


@pytest.mark.parametrize(
    "fragment",
    [
        "`tests/test_target.py`",  # a path is not an expression
        "`normalize_tags`",  # a bare identifier is not an expression
        "`a/b/c.py`",
        "`foo-bar`",
        "`*`",
        "the function",
    ],
)
def test_paths_and_names_are_not_code_references(fragment):
    assert not check(f'{fragment} violates "{SORTED_CRITERION}".').has_code_reference


# ----------------------------------------------------------------------
# acceptance criteria
# ----------------------------------------------------------------------
def test_criterion_named_verbatim_without_quotes():
    assert check(f"line 6 breaks: {SORTED_CRITERION}").has_acceptance_criterion


def test_criterion_match_ignores_case_and_whitespace():
    shouted = "THE RETURNED   LIST is sorted ascending, NOT merely deduplicated"
    assert check(f"line 6 breaks: {shouted}").has_acceptance_criterion


def test_quoted_excerpt_of_a_criterion_counts():
    assert check('line 6 breaks "returned list is sorted ascending"').has_acceptance_criterion


def test_restating_requirements_in_other_words_is_not_a_criterion():
    message = "line 6 does not trim whitespace, lowercase, drop empty entries, or sort"
    assert not check(message).has_acceptance_criterion


def test_short_criterion_counts_only_when_quoted_exactly():
    short = ["it exists"]
    assert check('line 1 breaks "it exists"', criteria=short).has_acceptance_criterion
    assert not check("line 1 breaks it exists", criteria=short).has_acceptance_criterion
    assert not check('line 1 breaks "exists"', criteria=short).has_acceptance_criterion


def test_quoted_values_do_not_cite_a_criterion():
    # 'a' appears inside many criteria; a quoted value must not count.
    assert not check("line 6 returns ['b', 'a'] instead of ['a', 'b']").has_acceptance_criterion


def test_quoted_path_inside_a_criterion_does_not_cite_it():
    # "tests/test_target.py is unchanged" contains the path, but quoting the
    # path names a file, not the criterion.
    assert not check("line 1 of `tests/test_target.py` is wrong").has_acceptance_criterion


def test_no_criteria_means_no_criterion_can_be_named():
    assert not check(GOOD_BLOCKER, criteria=[]).has_acceptance_criterion


# ----------------------------------------------------------------------
# files
# ----------------------------------------------------------------------
@pytest.mark.parametrize("path", ["target.py", "./target.py", ".\\target.py", "tests\\test_target.py"])
def test_workspace_file_paths_are_normalised(path):
    assert check(GOOD_BLOCKER, file=path).has_relevant_file


def test_unknown_file_is_reported():
    result = check(GOOD_BLOCKER, file="src/elsewhere.py")
    assert not result.has_relevant_file
    assert "relevant workspace file" in result.missing


def test_finding_without_a_file_is_not_penalised():
    assert check(GOOD_BLOCKER, file=None).has_relevant_file


# ----------------------------------------------------------------------
# runtime claims and expected/actual evidence
# ----------------------------------------------------------------------
BASE = f'target.py:6 `list(set(tags))` violates "{SORTED_CRITERION}": '


@pytest.mark.parametrize(
    "claim",
    [
        'normalize_tags(["b", "a"]) expected ["a", "b"], actual ["b", "a"]',
        'normalize_tags(["b", "a"]) returns ["b", "a"] instead of ["a", "b"]',
        'instead of ["a", "b"], normalize_tags(["b", "a"]) returns ["b", "a"]',
        'normalize_tags(["b", "a"]) should return ["a", "b"] but returns ["b", "a"]',
        'normalize_tags(["b", "a"]) should be ["a", "b"] but is ["b", "a"]',
        'expected ["a", "b"] but got ["b", "a"]',
        'got ["b", "a"], expected ["a", "b"]',
        "normalize_tags([]) raises KeyError instead of returning []",
    ],
)
def test_equivalent_expected_actual_phrasings_are_accepted(claim):
    result = check(BASE + claim)
    assert result.has_expected_actual
    assert result.is_supported


@pytest.mark.parametrize(
    "claim",
    [
        "the function returns the wrong order",
        "it fails for unsorted input",
        # A fix suggestion in a separate sentence is not observed behaviour.
        "the output is unordered. Use sorted() instead of set().",
        "the expected behaviour is not met",
    ],
)
def test_runtime_claims_without_an_observed_pair_are_unsupported(claim):
    result = check(BASE + claim)
    assert result.claims_runtime_behaviour
    assert not result.has_expected_actual
    assert "expected/actual behaviour" in result.missing


def test_quoting_a_criterion_is_not_itself_a_runtime_claim():
    # SORTED_CRITERION contains "returned"; citing it must not demand a pair.
    result = check(f'target.py:6 `list(set(tags))` violates "{SORTED_CRITERION}".')
    assert not result.claims_runtime_behaviour
    assert result.is_supported


def test_non_runtime_claim_does_not_need_expected_actual():
    result = check(
        'tests/test_target.py:1 was edited although "tests/test_target.py is unchanged" '
        "is required",
        file="tests/test_target.py",
    )
    assert not result.claims_runtime_behaviour
    assert result.is_supported


# ----------------------------------------------------------------------
# report semantics
# ----------------------------------------------------------------------
def test_only_unsupported_blockers_make_an_invalid_rejection():
    result = report({"severity": "blocker", "file": "target.py", "message": "Wrong."})
    assert result.is_invalid_rejection
    assert len(result.unsupported_blockers) == 1


def test_one_supported_blocker_keeps_the_rejection_valid():
    result = report(
        {"severity": "blocker", "file": "target.py", "message": "Wrong."},
        {"severity": "blocker", "file": "target.py", "message": GOOD_BLOCKER},
    )
    assert not result.is_invalid_rejection
    assert len(result.unsupported_blockers) == 1
    assert len(result.supported_findings) == 1


def test_unsupported_non_blockers_never_make_a_rejection_invalid():
    result = report({"severity": "major", "file": "target.py", "message": "Wrong."})
    assert result.unsupported_blockers == ()
    assert not result.is_invalid_rejection


def test_rejection_without_findings_is_not_judged_by_the_guard():
    # Blockers only, for now; documented in docs/architecture.md.
    assert not report().is_invalid_rejection


def test_shape_check_cannot_detect_a_well_formed_false_claim():
    """Known limit: a fabricated finding with the right shape is supported.

    The guard is a format gate, not a judge of truth. Verification remains the
    independent ground truth, and the guard never approves anything.
    """
    fabricated = 'Line 6 violates "normalize_tags trims, lowercases, drops blanks, deduplicates, and sorts".'
    assert check(fabricated).is_supported
