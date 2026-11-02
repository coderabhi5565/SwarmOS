# Execution safety

## What runs, and where

A run creates a temporary directory. The canonical workspace is a copy; coding
branches check out their own subdirectory and the scheduler merges a branch only
after conflict checks. The Verification Agent then runs a command inside the
canonical workspace.

This is **containment**, not a sandbox. It does not provide kernel isolation,
cgroups, a network namespace, or a separate user.

## Controls that are implemented

| Control | Default | Effect |
| --- | --- | --- |
| `SWARMOS_EXECUTION_ENABLED` | `1` | `0` refuses to run any command (exit 126) |
| `SWARMOS_ALLOWED_COMMANDS` | `python,python3,py,pytest` | binary allowlist; no shell is invoked |
| `SWARMOS_VERIFY_TIMEOUT_SECONDS` | `120` | process **tree** is killed on timeout |
| Environment allowlist | fixed list | provider keys are not inherited by test code |
| Path checks | always | absolute paths, `..`, `~`, and drive paths are rejected |
| Symlink handling | always | symlinks are never read into a snapshot or copied |
| `SWARMOS_ALLOW_REPO_CHECKOUT` | `0` | copying a real repository is opt-in |
| `SWARMOS_API_TOKEN` | unset | when set, every `/api` route requires a bearer token |
| `SWARMOS_ALLOW_REMOTE_BIND` | `0` | non-loopback binds are refused by the CLI |
| Snapshot cap | 400k chars | limits what is sent to a model |

The test subprocess receives only `PATH`, `PATHEXT`, `SYSTEMROOT`,
`SYSTEMDRIVE`, `COMSPEC`, `WINDIR`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`,
`LANG`, `LC_ALL`, plus `PYTHONPATH` pointing at the workspace. `OPENAI_COMPAT_*`
and `SWARMOS_*` are not inherited.

## What is not protected

- A malicious test file can read any file the **server user** can read. The
  environment filter only stops environment-variable leakage.
- Network access is not blocked. Test code can make outbound requests.
- There is no CPU or memory quota. A runaway test is stopped by the timeout only.
- The process runs as the same user as the API.
- On Windows the timeout kills the process tree with `taskkill /T`; a detached
  grandchild that leaves the tree is not guaranteed to die.

Therefore: **never expose the API on a public interface.** The CLI refuses a
non-loopback bind unless both `SWARMOS_ALLOW_REMOTE_BIND=1` and
`SWARMOS_API_TOKEN` are set, and it prints a warning when it does. Put an
authenticating proxy in front if remote access is genuinely required, and run the
service in a container or VM with no secrets mounted.

## Public demo mode (`SWARMOS_MODE=public_demo`)

The free hosting tier this project targets cannot run containers inside the
app, so there is no Docker or VM sandbox. The public demo instead layers
restrictions so that no visitor input ever becomes executed code or a prompt:

| Layer | What it does | Where |
| --- | --- | --- |
| Curated tasks only | Visitors pick a catalog task. No free-form goal, no seed files, no provider override, no inline (`wait=true`) runs | `RunService.check_public_demo`, `GET /api/demo-tasks` |
| Static code policy | Every generated `.py` file is parsed before merge. Imports must come from an allowlist of side-effect-free stdlib modules. `eval`, `exec`, `open`, `__import__`, `getattr` and similar are refused, as is dunder attribute access (`__class__`, `__globals__`, …). A violation is a retryable step failure | `app/runtime/code_policy.py` |
| Restricted test runner | `python -m pytest` is rewritten to `python -I sandbox_launcher.py`. Before any workspace code loads, the launcher installs a `sys.addaudithook` hook that refuses sockets, process creation, `ctypes`, writes outside the workspace, and reads outside the workspace and the Python installation. Temp files go into the workspace; plugin autoload is off | `app/runtime/sandbox_launcher.py` |
| Resource limits (POSIX) | CPU seconds, 1 GiB address space, 16 MiB file size, 256 open files, no core dumps, plus the parent's wall-clock timeout | `apply_resource_limits` |
| Abuse limits | Per-client sliding-window rate limit, global cap on concurrent runs; live trace streams capped at 4 per client and 40 in total, each closed after a maximum lifetime; endpoint probe and cancellation are disabled; `base_url` is redacted from `/api/config` | `app/rate_limit.py`, `app/streaming.py`, `app/main.py` |
| Fail closed | The API and `swarmos serve` refuse to start in `public_demo` if the sandbox or the code policy is off, or repository checkout is on | `Settings.startup_errors` |
| Redacted run data | Every response that carries a run is redacted at the response boundary: no host path, executed command line, endpoint, key, credential or IP address. Stored traces are unchanged | `app/redaction.py` |

What this is **not**: kernel isolation. An audit hook does not stop native
code, and a static policy can in principle be evaded. These layers are
meaningful together because the demo never runs code derived from visitor
input: the code is written by a model from prompts this server controls, for
a fixed task, and must pass the policy before the hooked runner executes it.
Do not enable `local` mode, free-form goals, or uploaded files on a public
deployment.

Validated so far: the launcher's escape tests pass on Windows
(`tests/test_public_demo.py`). Linux, the deployment target, must be validated
in CI before deploying.

### What visitors see of a run

Runs and traces are stored exactly as recorded, so `local` mode keeps every
detail for debugging (including the full command line verification
executed). Before M6.3 closed, the public demo served them as stored too.
The verification result records the command it executed:
`Workspace.run_command` replaces `python` with the absolute interpreter
path, and the restricted runner adds the launcher's path, the temporary
workspace and its pytest temp directory. Those absolute paths, and the
account's home directory with them, reached visitors through the run
detail, the polled events and the live stream.

`app.redaction.PublicRedactor` now builds the public representation, and
`app/main.py` applies it in `public_demo` mode to every route that returns
run data, for traces recorded before the fix as much as for new ones:

| Route | Redacted |
| --- | --- |
| `GET /api/runs/{id}`, `POST /api/runs` | the run record and its events |
| `GET /api/runs/{id}/events` | each event |
| `GET /api/runs/{id}/stream` | each event, before it is framed (ids and order unchanged) |
| `GET /api/runs` | each listed run |
| `GET /api/config` | the configured verification command |
| `POST /api/runs` errors (400) | the message |
| Benchmark experiments | free-text errors and the verification command (`app/benchmarks/views.py`) |

The representation:

- **Commands are an allowlist.** A `command` field is shown only when it is
  the server's configured verification command (e.g. `python -m pytest -q`);
  the executed command line becomes `[redacted]`.
- **Truncated output** (stdout and stderr are kept up to the last 4000
  characters) loses its first, partial line, which can begin inside a path.
- **Every other string, at any depth** (dict keys too), loses the configured
  key, endpoint URL and endpoint host; credential-like tokens and
  `*_KEY=value` style assignments; URLs; absolute Windows, UNC, POSIX and
  `~` paths (repr-escaped ones too); and IPv4 and bracketed IPv6 addresses.
  A path inside a run's temporary workspace keeps only its workspace-relative
  part (`tests/test_target.py:12`).
- **Kept:** event ids, sequence numbers, times, kinds, agents and steps,
  statuses, verification outcomes and counts, timings, error classes, and
  dependency and revision relationships. No event is dropped.

This redacts the stored representation; it is not an explicit public
response schema that names every field a visitor may see, and so not
proof against every future free-text format. The rules are pattern-based
beyond the command allowlist: they can redact a little too much (an IPv4-like version string, an API path such as
`/api/demo-tasks`, text between two slashes), which is the safe direction.
A new free-text field that holds host details in a form the rules do not
recognise would not be caught; `tests/test_public_redaction.py` is where
such a form should be added.

## Repository workflow

There is no live-repository workflow yet: no clone, branch, commit, push, or PR.
`Workspace.from_repository` copies a directory for a future workflow and is
disabled by default. When enabled it skips `.git`, virtualenvs, caches, `.env*`,
key material, credentials files, and databases, and it does not follow symlinks.
The copy still has no git history, so nothing can be pushed back.

## Agent and budget limits

- `max_agent_calls` and `max_wall_seconds` are enforced by the ledger before each
  call and always apply.
- `max_retries`, `max_revisions`, and `max_escalations` bound the loops.
- USD limits apply **only** when pricing is configured, and they are a soft cap
  rather than a hard limit: parallel in-flight calls can collectively exceed the
  configured amount. See [providers.md](providers.md).
- A coding branch cannot report a step complete: only the serial merge node can,
  after conflict validation.

## Reporting a concern

If you find a way to escape the workspace, leak a credential into a snapshot, or
exceed a limit, treat it as a security issue and do not open a public issue with
a working exploit.
