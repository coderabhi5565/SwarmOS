"""Static policy for model-generated code in the restricted public demo.

Before a coder's change is merged, every Python file it writes is parsed and
checked against a small allowlist. This is one layer of defence in depth for
the public demo, alongside curated tasks, the audited test runner, and
resource limits. It is not a sandbox: a static check of Python can be
evaded by a determined author, which is why it never runs alone.

The policy is deliberately narrow because demo tasks are small, pure
functions. It rejects:

* imports outside an allowlist of side-effect-free standard modules;
* calls to dynamic-execution and I/O builtins (``eval``, ``open``, ...);
* any dunder attribute access (``x.__class__``, ``f.__globals__``), the usual
  route out of a restricted namespace;
* non-Python files, unless the task explicitly allows them as text.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass

ALLOWED_IMPORTS = frozenset(
    {
        "__future__",
        "abc",
        "bisect",
        "collections",
        "collections.abc",
        "dataclasses",
        "decimal",
        "enum",
        "fractions",
        "functools",
        "heapq",
        "itertools",
        "math",
        "operator",
        "re",
        "statistics",
        "string",
        "typing",
    }
)

BANNED_NAMES = frozenset(
    {
        "__builtins__",
        "__import__",
        "breakpoint",
        "compile",
        "delattr",
        "eval",
        "exec",
        "getattr",
        "globals",
        "help",
        "input",
        "locals",
        "memoryview",
        "open",
        "setattr",
        "vars",
    }
)

# ``super().__init__(...)`` is ordinary code. Every other dunder attribute is
# refused: ``__class__``, ``__subclasses__``, ``__globals__``, ``__dict__`` and
# friends are how code climbs out of a restricted namespace.
ALLOWED_DUNDER_ATTRIBUTES = frozenset({"__init__"})

# Plain-text files a task may allow, e.g. documentation the coder writes.
TEXT_SUFFIXES = (".md", ".txt")

MAX_SOURCE_CHARS = 20_000


@dataclass(frozen=True)
class PolicyViolation:
    path: str
    line: int
    reason: str

    def describe(self) -> str:
        return f"{self.path}:{self.line}: {self.reason}"


def check_file(path: str, content: str) -> list[PolicyViolation]:
    """Return every policy violation in one file the coder wants to write."""
    if path.endswith(TEXT_SUFFIXES):
        return []
    if not path.endswith(".py"):
        return [PolicyViolation(path, 0, "only .py, .md and .txt files may be written")]
    if len(content) > MAX_SOURCE_CHARS:
        return [PolicyViolation(path, 0, f"source exceeds {MAX_SOURCE_CHARS} characters")]
    try:
        tree = ast.parse(content, filename=path)
    except SyntaxError as exc:
        return [PolicyViolation(path, exc.lineno or 0, f"syntax error: {exc.msg}")]

    visitor = _PolicyVisitor(path)
    visitor.visit(tree)
    return visitor.violations


def check_changes(changes) -> list[PolicyViolation]:
    """Check a coder's file changes. Deletions carry no code and always pass."""
    violations: list[PolicyViolation] = []
    for change in changes:
        if change.action == "delete":
            continue
        violations.extend(check_file(change.path, change.content))
    return violations


class _PolicyVisitor(ast.NodeVisitor):
    def __init__(self, path: str) -> None:
        self.path = path
        self.violations: list[PolicyViolation] = []

    def _flag(self, node: ast.AST, reason: str) -> None:
        self.violations.append(
            PolicyViolation(self.path, getattr(node, "lineno", 0), reason)
        )

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if alias.name not in ALLOWED_IMPORTS:
                self._flag(node, f"import of {alias.name!r} is not allowed")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        if node.level:
            self._flag(node, "relative imports are not allowed")
        elif module not in ALLOWED_IMPORTS:
            self._flag(node, f"import from {module!r} is not allowed")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in BANNED_NAMES:
            self._flag(node, f"use of {node.id!r} is not allowed")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if (
            node.attr.startswith("__")
            and node.attr.endswith("__")
            and node.attr not in ALLOWED_DUNDER_ATTRIBUTES
        ):
            self._flag(node, f"dunder attribute access {node.attr!r} is not allowed")
        self.generic_visit(node)

    def visit_Global(self, node: ast.Global) -> None:
        self._flag(node, "global statements are not allowed")
        self.generic_visit(node)
