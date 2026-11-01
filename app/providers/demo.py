"""Deterministic fixture provider.

This provider exists so the full graph -- planning, parallel coding, review,
verification, tracing, and persistence -- can run and be tested without any
external model. It is explicitly labelled as a fixture wherever it surfaces.

It responds to the same typed prompts as a real model, so replacing it with a
real provider changes no orchestration code.
"""

from __future__ import annotations

import json
import time

from app.providers.base import ModelRequest, ModelResponse, ProviderError

_IMPLEMENTATION = '''"""Tag normalization helpers."""

from collections.abc import Iterable


def normalize_tags(tags: Iterable[str]) -> list[str]:
    """Trim, lower-case, drop blanks, de-duplicate, and sort tags."""
    cleaned = {tag.strip().lower() for tag in tags if tag and tag.strip()}
    return sorted(cleaned)
'''


class DemoProvider:
    name = "demo"

    async def complete(self, request: ModelRequest) -> ModelResponse:
        started = time.perf_counter()
        text = self._respond(request)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return ModelResponse(
            text=text,
            model=request.model,
            provider=self.name,
            input_tokens=max(1, len(request.user) // 4),
            output_tokens=max(1, len(text) // 4),
            latency_ms=elapsed_ms,
        )

    def _respond(self, request: ModelRequest) -> str:
        try:
            payload = json.loads(request.user)
        except (TypeError, ValueError) as exc:
            raise ProviderError(f"demo provider expects JSON input: {exc}") from exc

        if request.role == "planner":
            return json.dumps(self._plan(str(payload.get("goal", ""))))
        if request.role == "coder":
            return json.dumps(self._code(payload))
        if request.role == "reviewer":
            return json.dumps(self._review(payload))
        raise ProviderError(f"demo provider has no script for role {request.role!r}")

    @staticmethod
    def _plan(goal: str) -> dict:
        short_goal = goal.strip()[:400] or "the requested change"
        return {
            "assumptions": [
                "Demo fixture: the sample workspace contains a failing test for tag normalisation.",
            ],
            "steps": [
                {
                    "id": "inspect_tests",
                    "title": "Inspect the failing tests",
                    "detail": f"Read tests/test_target.py and state the behaviour required by: {short_goal}",
                    "acceptance_criteria": ["The required behaviour is stated in plain language"],
                    "depends_on": [],
                    "target_files": [],
                },
                {
                    "id": "draft_implementation",
                    "title": "Implement the required behaviour",
                    "detail": "Implement normalize_tags in target.py so the test suite passes.",
                    "acceptance_criteria": ["tests/test_target.py passes"],
                    "depends_on": [],
                    "target_files": ["target.py"],
                },
                {
                    "id": "document_change",
                    "title": "Document the change",
                    "detail": f"Explain the change and its rationale in docs/change-notes.md for: {short_goal}",
                    "acceptance_criteria": ["docs/change-notes.md records the change and rationale"],
                    "depends_on": ["inspect_tests", "draft_implementation"],
                    "target_files": ["docs/change-notes.md"],
                },
            ],
        }

    @staticmethod
    def _code(payload: dict) -> dict:
        step = payload.get("step") or {}
        step_id = str(step.get("id", ""))
        files: dict[str, str] = payload.get("files") or {}
        findings = payload.get("review_findings") or []
        verification_stdout = str(payload.get("verification_stdout") or "")

        if step_id == "inspect_tests":
            test_files = sorted(path for path in files if path.startswith("tests/"))
            return {
                "step_id": step_id,
                "summary": "Required behaviour: normalize_tags must trim, lower-case, "
                "drop blanks, de-duplicate, and sort.",
                "rationale": f"Inspected {', '.join(test_files) or 'the workspace'}.",
                "changes": [],
            }

        if step_id in {"draft_implementation", "apply_implementation"}:
            rationale = "Satisfies the assertions in tests/test_target.py."
            if findings:
                rationale += f" Addressed {len(findings)} review finding(s)."
            if verification_stdout:
                rationale += " Revised after a failed verification run."
            return {
                "step_id": step_id,
                "summary": "Implemented normalize_tags and replaced the NotImplementedError stub.",
                "rationale": rationale,
                "changes": [
                    {"path": "target.py", "content": _IMPLEMENTATION, "action": "update"}
                ],
            }

        if step_id == "document_change":
            goal = str(payload.get("goal", "")).strip()
            note = (
                "# Change notes\n\n"
                f"Goal: {goal}\n\n"
                "## What changed\n\n"
                "- Implemented `normalize_tags` in `target.py`.\n\n"
                "## Why\n\n"
                "The failing tests describe the intended contract: trim whitespace, "
                "lower-case, drop blank entries, de-duplicate, and return a sorted list.\n"
            )
            return {
                "step_id": step_id,
                "summary": "Added docs/change-notes.md describing the change.",
                "rationale": "Keeps the workspace self-documenting.",
                "changes": [{"path": "docs/change-notes.md", "content": note, "action": "create"}],
            }

        return {
            "step_id": step_id or "unknown",
            "summary": f"Demo fixture has no scripted change for step {step_id!r}.",
            "rationale": "",
            "changes": [],
        }

    @staticmethod
    def _review(payload: dict) -> dict:
        files: dict[str, str] = payload.get("files") or {}
        target = files.get("target.py", "")
        # Blockers carry the evidence the review guard requires (a line or
        # expression, a quoted criterion, expected versus actual), as the
        # reviewer prompt demands of a real model.
        criterion = DemoProvider._implementation_criterion(payload)
        if "def normalize_tags" not in target:
            return {
                "verdict": "request_changes",
                "rationale": "target.py does not define normalize_tags yet.",
                "findings": [
                    {
                        "severity": "blocker",
                        "step_id": "draft_implementation",
                        "file": "target.py",
                        "message": (
                            "target.py:1 has no `def normalize_tags(tags)`, so "
                            f'"{criterion}" cannot hold.'
                        ),
                    }
                ],
            }
        if "NotImplementedError" in target:
            line = next(
                index
                for index, text in enumerate(target.splitlines(), start=1)
                if "NotImplementedError" in text
            )
            return {
                "verdict": "request_changes",
                "rationale": "The stub still raises NotImplementedError.",
                "findings": [
                    {
                        "severity": "blocker",
                        "step_id": "draft_implementation",
                        "file": "target.py",
                        "message": (
                            f'target.py:{line} violates "{criterion}": '
                            "normalize_tags([]) is expected to return [], but the "
                            "actual call raises NotImplementedError."
                        ),
                    }
                ],
            }
        return {
            "verdict": "approve",
            "rationale": "The implementation matches the acceptance criteria and the test contract.",
            "findings": [],
        }

    @staticmethod
    def _implementation_criterion(payload: dict) -> str:
        """The plan criterion a blocker on target.py cites, quoted exactly."""
        steps = (payload.get("plan") or {}).get("steps") or []
        ordered = sorted(steps, key=lambda step: step.get("id") != "draft_implementation")
        for step in ordered:
            for criterion in step.get("acceptance_criteria") or []:
                return str(criterion)
        return "the tests pass"