"""Restricted pytest launcher for the public demo.

Run as ``python -I sandbox_launcher.py <workspace> [pytest args...]``. It must
stay standard-library only: ``-I`` keeps the workspace, the current directory
and user site-packages off ``sys.path`` until this file has installed its
guards.

Before any workspace code is imported it:

1. applies POSIX resource limits (CPU, address space, file size, open files,
   core dumps) when the ``resource`` module exists;
2. installs a ``sys.addaudithook`` hook that refuses network sockets, process
   creation, ``ctypes``, writes outside the workspace, and reads outside the
   workspace and the Python installation.

An audit hook cannot be removed from Python code, and the static code policy
already refuses ``ctypes`` and dynamic imports. This is defence in depth for
curated demo tasks, not kernel isolation: it does not stop native code, and it
cannot bound wall time (the parent's timeout does).
"""

from __future__ import annotations

import os
import sys

_BLOCKED_PREFIXES = (
    "ctypes.",
    "socket.",
    "subprocess.",
    "os.exec",
    "os.spawn",
    "os.posix_spawn",
    "os.fork",
    "os.forkpty",
    "os.kill",
    "os.killpg",
    "os.startfile",
    "os.system",
    "pty.",
    "webbrowser.",
    "winreg.",
    "_winapi.",
)
# Events whose first argument is a path that is modified.
_WRITE_EVENTS = {
    "os.chmod",
    "os.chown",
    "os.link",
    "os.mkdir",
    "os.remove",
    "os.rename",
    "os.rmdir",
    "os.symlink",
    "os.truncate",
    "os.utime",
    "shutil.rmtree",
    "shutil.copyfile",
    "shutil.copytree",
    "shutil.move",
}
# Events whose first argument is a path that is read.
_READ_EVENTS = {"os.listdir", "os.scandir", "glob.glob"}
_WRITE_MODE = set("wax+")
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
_ALWAYS_READABLE = {os.devnull}

_LIMITS_MB_ADDRESS_SPACE = 1024
_LIMITS_MB_FILE_SIZE = 16
_LIMITS_OPEN_FILES = 256


class SandboxViolation(PermissionError):
    pass


def _norm(path) -> str | None:
    if isinstance(path, int):
        return None  # an already-open descriptor
    if isinstance(path, bytes):
        path = os.fsdecode(path)
    try:
        path = os.fspath(path)
    except TypeError:
        return None
    return os.path.normcase(os.path.realpath(path))


def _under(path: str, roots: tuple[str, ...]) -> bool:
    return any(path == root or path.startswith(root + os.sep) for root in roots)


def build_hook(workspace: str, read_roots: tuple[str, ...]):
    write_roots = (workspace,)
    readable = tuple(sorted({workspace, *read_roots}))
    always = {_norm(item) for item in _ALWAYS_READABLE}

    def check_read(path) -> None:
        target = _norm(path)
        if target is None or target in always or _under(target, readable):
            return
        raise SandboxViolation(f"SwarmOS sandbox: read outside the workspace: {path!r}")

    def check_write(path) -> None:
        target = _norm(path)
        # The null device is a sink; pytest's logging plugin opens it for writing.
        if target is None or target in always or _under(target, write_roots):
            return
        raise SandboxViolation(f"SwarmOS sandbox: write outside the workspace: {path!r}")

    def hook(event: str, args: tuple) -> None:
        if event.startswith(_BLOCKED_PREFIXES):
            raise SandboxViolation(f"SwarmOS sandbox: {event} is not allowed")
        if event == "open":
            path, mode, flags = (tuple(args) + (None, None, None))[:3]
            writes = bool(set(str(mode or "")) & _WRITE_MODE) or bool(
                isinstance(flags, int) and flags & _WRITE_FLAGS
            )
            (check_write if writes else check_read)(path)
        elif event in _WRITE_EVENTS:
            for path in args[:2] if event in {"os.rename", "os.link", "os.symlink",
                                              "shutil.copyfile", "shutil.copytree",
                                              "shutil.move"} else args[:1]:
                if isinstance(path, (str, bytes, os.PathLike)):
                    check_write(path)
        elif event in _READ_EVENTS and args:
            if isinstance(args[0], (str, bytes, os.PathLike)):
                check_read(args[0])

    return hook


def apply_resource_limits(cpu_seconds: int) -> list[str]:
    """Apply POSIX rlimits to this process. Returns the limits applied."""
    try:
        import resource
    except ImportError:  # Windows: no rlimits; the parent timeout still applies
        return []
    applied: list[str] = []
    limits = {
        "RLIMIT_CPU": cpu_seconds,
        "RLIMIT_AS": _LIMITS_MB_ADDRESS_SPACE * 1024 * 1024,
        "RLIMIT_FSIZE": _LIMITS_MB_FILE_SIZE * 1024 * 1024,
        "RLIMIT_NOFILE": _LIMITS_OPEN_FILES,
        "RLIMIT_CORE": 0,
    }
    for name, value in limits.items():
        limit = getattr(resource, name, None)
        if limit is None:
            continue
        _, hard = resource.getrlimit(limit)
        if hard != resource.RLIM_INFINITY:
            value = min(value, hard)
        resource.setrlimit(limit, (value, value))
        applied.append(name)
    return applied


def _python_roots() -> tuple[str, ...]:
    import site
    import sysconfig

    candidates = {
        sys.prefix,
        sys.base_prefix,
        sys.exec_prefix,
        sys.base_exec_prefix,
        os.path.dirname(sys.executable),
        *(sysconfig.get_paths().values()),
    }
    try:
        candidates.update(site.getsitepackages())
    except AttributeError:
        pass
    return tuple(sorted(n for n in (_norm(c) for c in candidates if c) if n))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: sandbox_launcher.py <workspace> [pytest args...]", file=sys.stderr)
        return 2
    workspace = _norm(argv[1])
    pytest_args = argv[2:]
    cpu_seconds = int(os.environ.get("SWARMOS_SANDBOX_CPU_SECONDS", "60"))

    apply_resource_limits(cpu_seconds)
    os.chdir(workspace)
    # Import pytest and its dependencies before the hook, from the Python
    # installation only; workspace code is imported after the hook is live.
    import pytest

    sys.addaudithook(build_hook(workspace, _python_roots()))
    sys.path.insert(0, workspace)
    return int(pytest.main(pytest_args))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
