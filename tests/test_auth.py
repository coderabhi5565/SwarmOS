"""Accounts and roles: registration, sign-in by email or phone, sessions, and
who may do what in the public demo. Every credential is generated per test."""

from __future__ import annotations

import hashlib
import secrets
import time

import pytest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

import app.main as main_module
from app import auth
from app.demo_tasks import SAMPLE_TASK_ID
from tests.conftest import make_settings, new_account

PUBLIC = {"mode": "public_demo", "execution_sandbox": "restricted", "code_policy_enabled": True}
CATALOG_RUN = {"goal": "catalog run", "demo_task": SAMPLE_TASK_ID}
EXPERIMENT = {"suite_id": "catalog", "arm_ids": ["parallel"], "task_ids": [SAMPLE_TASK_ID], "repetitions": 1}


@pytest.fixture
def serve(tmp_path, monkeypatch):
    """A TestClient factory for the given settings (one per test)."""

    def _serve(**overrides) -> TestClient:
        monkeypatch.setattr(main_module, "settings", make_settings(tmp_path, **overrides))
        return TestClient(main_module.app)

    return _serve


def register(client: TestClient, account: dict[str, str] | None = None):
    """Register ``account`` (a new one by default) and leave the client signed
    out again; return the account, the response and the session token."""
    account = account or new_account()
    response = client.post("/api/auth/register", json=account)
    token = response.cookies.get(auth.SESSION_COOKIE)
    client.cookies.clear()
    return account, response, token


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ----------------------------------------------------------------------
# validation, hashing, masking
# ----------------------------------------------------------------------
@pytest.mark.parametrize(
    "raw, digits",
    [("+1 (555) 010-2030", "15550102030"), ("9876543210", "9876543210"), ("+44.20.7946.0018", "442079460018")],
)
def test_phone_numbers_normalize_to_digits(raw, digits):
    assert auth.normalize_phone(raw) == digits


@pytest.mark.parametrize("raw", ["555012345", "1" * 16, "+1 555 CALL NOW", "++15550102030", ""])
def test_invalid_phone_numbers_are_refused(raw):
    with pytest.raises(auth.AuthInputError):
        auth.normalize_phone(raw)


def test_phone_masking_keeps_the_last_four_digits():
    assert auth.mask_phone("9876543210") == "******3210"
    assert auth.mask_phone("15550102030") == "*******2030"


def test_passwords_are_salted_scrypt_hashes():
    password = secrets.token_urlsafe(12)
    first, second = auth.hash_password(password), auth.hash_password(password)
    assert first.startswith("scrypt$") and second.startswith("scrypt$")
    assert first != second  # a fresh salt each time
    assert password not in first
    assert auth.verify_password(password, first) and auth.verify_password(password, second)
    assert not auth.verify_password(password + "x", first)
    assert not auth.verify_password(password, "not-a-hash")


# ----------------------------------------------------------------------
# registration
# ----------------------------------------------------------------------
def test_registration_signs_in_with_an_http_only_cookie(serve):
    account = new_account()
    with serve() as client:
        response = client.post("/api/auth/register", json={**account, "email": account["email"].upper()})
        me = client.get("/api/auth/me").json()
    assert response.status_code == 201
    body = response.json()
    digits = auth.normalize_phone(account["phone"])
    assert body == {
        "authenticated": True,
        "user": {
            "user_id": body["user"]["user_id"],
            "full_name": account["full_name"],
            "email": account["email"].lower(),
            "phone_masked": "*" * (len(digits) - 4) + digits[-4:],
            "role": "user",
        },
    }
    assert body["user"]["user_id"].startswith("usr_")
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{auth.SESSION_COOKIE}=")
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
    assert "Secure" not in cookie  # plain HTTP locally
    assert me == {"authenticated": True, "user": body["user"], "mode": "local"}


def test_the_cookie_is_secure_behind_the_tls_proxy(serve):
    with serve(trust_proxy_headers=True) as client:
        _, response, _ = register(client)
    assert "Secure" in response.headers["set-cookie"]


def test_duplicate_email_or_phone_is_a_conflict(serve):
    with serve() as client:
        account, first, _ = register(client)
        same_email = {**new_account(), "email": account["email"].upper()}
        digits = auth.normalize_phone(account["phone"])
        # The same number, written differently.
        same_phone = {**new_account(), "phone": f"+{digits[:1]} ({digits[1:4]}) {digits[4:7]}-{digits[7:]}"}
        email_conflict = client.post("/api/auth/register", json=same_email)
        phone_conflict = client.post("/api/auth/register", json=same_phone)
    assert first.status_code == 201
    assert email_conflict.status_code == phone_conflict.status_code == 409
    assert email_conflict.json() == {"detail": "an account with this email already exists"}
    assert phone_conflict.json() == {"detail": "an account with this phone already exists"}


@pytest.mark.parametrize(
    "change, message",
    [
        ({"email": "not-an-email"}, "valid email"),
        ({"phone": "12345"}, "10 to 15 digits"),
        ({"password": "short"}, "at least 8"),
        ({"full_name": "   "}, "your name"),
    ],
)
def test_invalid_registrations_are_refused_without_echoing_input(serve, change, message):
    account = {**new_account(), **change}
    with serve() as client:
        response = client.post("/api/auth/register", json=account)
    assert response.status_code == 422
    assert message in response.json()["detail"]
    assert account["password"] not in response.text


def test_malformed_bodies_never_echo_the_password(serve):
    password = secrets.token_urlsafe(18)
    with serve() as client:
        missing = client.post("/api/auth/register", json={"password": password, "full_name": "A"})
        login = client.post("/api/auth/login", json={"password": password})
    assert missing.status_code == login.status_code == 422
    assert password not in missing.text and password not in login.text
    assert {tuple(error["loc"]) for error in missing.json()["detail"]} == {("body", "email"), ("body", "phone")}


# ----------------------------------------------------------------------
# sign-in and sign-out
# ----------------------------------------------------------------------
def test_sign_in_by_email_or_phone(serve):
    with serve() as client:
        account, _, _ = register(client)
        digits = auth.normalize_phone(account["phone"])
        by_email = client.post(
            "/api/auth/login", json={"identifier": f"  {account['email'].upper()} ", "password": account["password"]}
        )
        client.cookies.clear()
        by_phone = client.post(
            "/api/auth/login",
            json={"identifier": f"+{digits[:1]} {digits[1:4]} {digits[4:]}", "password": account["password"]},
        )
        me = client.get("/api/auth/me").json()
    for response in (by_email, by_phone):
        assert response.status_code == 200
        assert response.json()["authenticated"] is True
        assert response.json()["user"]["email"] == account["email"]
        assert response.cookies.get(auth.SESSION_COOKIE)
    assert me["authenticated"] is True and me["user"]["email"] == account["email"]


def test_a_wrong_password_and_an_unknown_account_look_the_same(serve):
    with serve() as client:
        account, _, _ = register(client)
        wrong = client.post("/api/auth/login", json={"identifier": account["email"], "password": account["password"] + "x"})
        unknown = client.post(
            "/api/auth/login", json={"identifier": new_account()["email"], "password": account["password"]}
        )
        not_an_identifier = client.post("/api/auth/login", json={"identifier": "??", "password": account["password"]})
        me = client.get("/api/auth/me").json()
    assert wrong.status_code == unknown.status_code == not_an_identifier.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": "incorrect email, phone or password"}
    assert auth.SESSION_COOKIE not in wrong.headers.get("set-cookie", "")
    assert me == {"authenticated": False, "user": None, "mode": "local"}


def test_sign_out_revokes_the_session(serve):
    with serve(**PUBLIC) as client:
        _, _, token = register(client)
        client.cookies.set(auth.SESSION_COOKIE, token)
        assert client.get("/api/auth/me").json()["authenticated"] is True
        assert client.get("/api/auth/me", headers=bearer(token)).json()["authenticated"] is True
        out = client.post("/api/auth/logout")
        after = client.get("/api/auth/me").json()
        replayed = client.get("/api/auth/me", headers=bearer(token)).json()
        refused = client.post("/api/runs", json=CATALOG_RUN, headers=bearer(token))
    assert out.status_code == 200
    assert out.json() == {"authenticated": False, "user": None}
    cleared = out.headers["set-cookie"]
    assert cleared.startswith(f"{auth.SESSION_COOKIE}=") and "Max-Age=0" in cleared
    assert after["authenticated"] is False
    assert replayed["authenticated"] is False  # the token itself is dead, not just the cookie
    assert refused.status_code == 401


def test_an_expired_session_is_not_accepted(serve):
    with serve() as client:
        _, _, token = register(client)
        with client.app.state.store.transaction("write") as conn:
            conn.execute("UPDATE auth_sessions SET expires_at = ?", (int(time.time()) - 1,))
        me = client.get("/api/auth/me", headers=bearer(token)).json()
    assert me["authenticated"] is False


def test_sign_in_and_registration_are_rate_limited_per_client(serve):
    with serve(login_attempts_per_client=3, registrations_per_client_per_hour=2) as client:
        account, _, _ = register(client)
        register(client)
        _, third, _ = register(client)
        attempts = [
            client.post("/api/auth/login", json={"identifier": account["email"], "password": "wrong-password"})
            for _ in range(4)
        ]
    assert third.status_code == 429 and int(third.headers["Retry-After"]) > 0
    assert [response.status_code for response in attempts] == [401, 401, 401, 429]
    assert int(attempts[-1].headers["Retry-After"]) > 0


# ----------------------------------------------------------------------
# authorization in the public demo
# ----------------------------------------------------------------------
def test_visitors_may_browse_but_not_act(serve):
    with serve(**PUBLIC) as client:
        for path in [
            "/health",
            "/api/config",
            "/api/demo-tasks",
            "/api/runs",
            "/api/benchmarks/suites",
            "/api/benchmarks/experiments",
            "/api/auth/me",
        ]:
            assert client.get(path).status_code == 200, path
        assert client.get("/api/benchmarks/suites").json()["can_create"] is False
        assert client.get("/api/auth/me").json() == {"authenticated": False, "user": None, "mode": "public_demo"}
        run = client.post("/api/runs", json=CATALOG_RUN)
        cancel = client.post("/api/runs/run_any/cancel")
        create = client.post("/api/benchmarks/experiments", json=EXPERIMENT)
        stop = client.post("/api/benchmarks/experiments/bex_any/cancel")
        forged = client.post("/api/runs", json=CATALOG_RUN, headers=bearer(secrets.token_urlsafe(32)))
        assert client.get("/api/runs").json()["runs"] == []
    assert run.status_code == cancel.status_code == create.status_code == stop.status_code == 401
    assert forged.status_code == 401
    assert run.json() == {"detail": "sign in to start a run"}
    assert cancel.json() == {"detail": "sign in to cancel a run"}


def test_users_run_catalog_tasks_and_cancel_only_their_own(serve):
    with serve(**PUBLIC) as client:
        _, _, alice = register(client)
        _, _, bob = register(client)
        started = client.post("/api/runs", json=CATALOG_RUN, headers=bearer(alice))
        run_id = started.json()["run"]["run_id"]
        by_bob = client.post(f"/api/runs/{run_id}/cancel", headers=bearer(bob))
        by_alice = client.post(f"/api/runs/{run_id}/cancel", headers=bearer(alice))
        # Still a catalog-only demo for a signed-in user.
        free_form = client.post("/api/runs", json={"goal": "anything at all"}, headers=bearer(alice))
        inline = client.post("/api/runs?wait=true", json=CATALOG_RUN, headers=bearer(alice))
        probe = client.get("/api/provider/models", headers=bearer(alice))
        suites = client.get("/api/benchmarks/suites", headers=bearer(alice)).json()
        create = client.post("/api/benchmarks/experiments", json=EXPERIMENT, headers=bearer(alice))
        stop = client.post("/api/benchmarks/experiments/bex_any/cancel", headers=bearer(alice))
    assert started.status_code == 202
    assert by_bob.status_code == 403
    assert by_bob.json() == {"detail": "you can cancel only runs you started"}
    assert by_alice.status_code in {202, 409}  # 409 if it already finished
    assert free_form.status_code == inline.status_code == probe.status_code == 403
    assert suites["can_create"] is False
    assert create.status_code == stop.status_code == 403
    assert create.json() == {"detail": "only operators may create benchmark experiments"}


def test_the_operator_email_makes_an_operator(serve):
    operator_email = new_account()["email"]
    with serve(**PUBLIC, operator_email=operator_email) as client:
        _, _, user = register(client)
        _, response, operator = register(client, new_account(operator_email.upper()))
        run_id = client.post("/api/runs", json=CATALOG_RUN, headers=bearer(user)).json()["run"]["run_id"]
        cancel_theirs = client.post(f"/api/runs/{run_id}/cancel", headers=bearer(operator))
        suites = client.get("/api/benchmarks/suites", headers=bearer(operator)).json()
        hidden_suite = client.post(
            "/api/benchmarks/experiments", json={**EXPERIMENT, "suite_id": "local-fixtures"}, headers=bearer(operator)
        )
        created = client.post("/api/benchmarks/experiments", json=EXPERIMENT, headers=bearer(operator))
        experiment_id = created.json()["experiment"]["experiment_id"]
        stopped = client.post(f"/api/benchmarks/experiments/{experiment_id}/cancel", headers=bearer(operator))
    assert response.json()["user"]["role"] == "operator"
    assert cancel_theirs.status_code in {202, 409}
    assert suites["can_create"] is True
    assert hidden_suite.status_code in {400, 404}  # public suites only, even for operators
    assert created.status_code == 202
    assert stopped.status_code in {202, 409}


def test_the_api_token_is_an_operator_credential_in_the_public_demo(serve):
    token = secrets.token_urlsafe(32)
    with serve(**PUBLIC, api_token=token) as client:
        health = client.get("/health").json()
        open_config = client.get("/api/config")
        me = client.get("/api/auth/me", headers=bearer(token)).json()
        suites = client.get("/api/benchmarks/suites", headers=bearer(token)).json()
        started = client.post("/api/runs", json=CATALOG_RUN, headers=bearer(token))
        client.post("/api/auth/logout", headers=bearer(token))  # cannot revoke the token
        still = client.get("/api/auth/me", headers=bearer(token)).json()
    assert health["auth_required"] is False and open_config.status_code == 200
    assert open_config.json()["api"]["auth_required"] is False
    assert me["user"] == {
        "user_id": "api_token",
        "full_name": "Operator (API token)",
        "email": None,
        "phone_masked": None,
        "role": "operator",
    }
    assert suites["can_create"] is True
    assert started.status_code == 202
    assert still["authenticated"] is True


def test_the_api_token_still_gates_the_whole_local_api(serve):
    token = secrets.token_urlsafe(32)
    with serve(api_token=token) as client:
        assert client.get("/health").json()["auth_required"] is True
        assert client.post("/api/auth/register", json=new_account()).status_code == 401
        assert client.get("/api/auth/me").status_code == 401
        me = client.get("/api/auth/me", headers=bearer(token)).json()
    assert me["authenticated"] is True and me["user"]["role"] == "operator"


def test_local_mode_needs_no_account(serve):
    with serve() as client:
        started = client.post("/api/runs", json=CATALOG_RUN)
        cancelled = client.post(f"/api/runs/{started.json()['run']['run_id']}/cancel")
        suites = client.get("/api/benchmarks/suites").json()
    assert started.status_code == 202
    assert cancelled.status_code in {202, 409}
    assert suites["can_create"] is True


# ----------------------------------------------------------------------
# nothing secret leaves the server or lands in the database
# ----------------------------------------------------------------------
def test_no_response_or_row_holds_a_password_full_phone_or_token(serve):
    with serve(**PUBLIC) as client:
        account = new_account()
        digits = auth.normalize_phone(account["phone"])
        registered = client.post("/api/auth/register", json=account)
        token = registered.cookies.get(auth.SESSION_COOKIE)
        client.cookies.clear()  # sign in afresh, leaving the first session alive
        signed_in = client.post("/api/auth/login", json={"identifier": account["email"], "password": account["password"]})
        second_token = signed_in.cookies.get(auth.SESSION_COOKIE)
        run_id = client.post("/api/runs", json=CATALOG_RUN).json()["run"]["run_id"]
        bodies = [
            registered.text,
            signed_in.text,
            client.get("/api/auth/me").text,
            client.get("/api/runs").text,
            client.get(f"/api/runs/{run_id}").text,
            client.get(f"/api/runs/{run_id}/events").text,
            client.post("/api/auth/logout").text,
        ]
        with client.app.state.store.transaction("read") as conn:
            users = [dict(row) for row in conn.execute("SELECT * FROM users")]
            sessions = [dict(row) for row in conn.execute("SELECT * FROM auth_sessions")]
    for body in bodies:
        assert account["password"] not in body
        assert digits not in body
        assert token not in body and second_token not in body
        assert "password_hash" not in body and "scrypt$" not in body
    # Run responses say nothing about who started the run.
    assert account["email"] not in "".join(bodies[3:6])
    [user] = users
    assert user["password_hash"].startswith("scrypt$") and account["password"] not in user["password_hash"]
    assert user["role"] == "user" and user["phone"] == digits
    # Only the first session is left (logout revoked the second), stored as its hash.
    assert [s["token_hash"] for s in sessions] == [hashlib.sha256(token.encode()).hexdigest()]
    assert all(token not in str(value) for session in sessions for value in session.values())


def test_credentialed_cors_follows_the_configured_origins():
    [cors] = [m for m in main_module.app.user_middleware if m.cls is CORSMiddleware]
    assert cors.kwargs["allow_credentials"] is bool(main_module.settings.cors_origin_list)
    assert "*" not in cors.kwargs["allow_origins"]  # credentials never go to any origin
