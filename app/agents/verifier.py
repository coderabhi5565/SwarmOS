"""The Verification Agent runs approved tests and reports objective evidence.

It deliberately does not use a language model: verification must be a command,
an exit code, and captured output, not an opinion.
"""

from __future__ import annotations

from app.models import VerificationResult
from app.runtime.workspace import Workspace


class VerificationAgent:
    role = "verifier"

    def __init__(self, command: str, timeout_seconds: int) -> None:
        self.command = command
        self.timeout_seconds = timeout_seconds

    def verify(
        self, workspace: Workspace, timeout_seconds: int | None = None
    ) -> VerificationResult:
        """Run the command; ``timeout_seconds`` may only tighten the configured one."""
        timeout = self.timeout_seconds
        if timeout_seconds is not None:
            timeout = max(1, min(timeout, timeout_seconds))
        return workspace.run_command(self.command, timeout)