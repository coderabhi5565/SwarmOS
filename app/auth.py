"""Accounts, sessions and roles. Standard library only.

* Passwords are hashed with scrypt and a random 16-byte salt per user, and
  compared in constant time. Plaintext passwords are never stored or logged.
* A session is a random token. The client holds the token (an HttpOnly
  cookie, or ``Authorization: Bearer``); the database holds only its SHA-256,
  so a copy of the database does not hold usable sessions.
* Two roles: ``user`` and ``operator``. A user is an operator when their email
  is ``SWARMOS_OPERATOR_EMAIL``; ``SWARMOS_API_TOKEN`` is an operator
  credential too. The role is worked out on every request from the current
  configuration, so changing that setting takes effect without a migration.

The tables (``users``, ``auth_sessions``, ``run_owners``) live in the run
database; see ``app.store``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from app.models import utc_now

if TYPE_CHECKING:
    from app.config import Settings
    from app.store import RunStore

Role = Literal["user", "operator"]

SESSION_COOKIE = "swarmos_session"
# The subject recorded for runs started with SWARMOS_API_TOKEN.
API_TOKEN_SUBJECT = "api_token"

MAX_EMAIL = 254
MIN_PASSWORD = 8
MAX_PASSWORD = 256
MAX_NAME = 100
PHONE_DIGITS = (10, 15)

# scrypt cost: n=2**14, r=8 needs 16 MiB and roughly 50 ms per hash.
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_LEN = 2**14, 8, 1, 64
_SALT_BYTES = 16

_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")
_PHONE_SEPARATORS = re.compile(r"[\s\-().]")
_PHONE = re.compile(r"^\+?(\d+)$")


class AuthInputError(ValueError):
    """Input that cannot be an email, phone, name or password. The message
    names the field and never quotes the value."""


class DuplicateAccountError(Exception):
    def __init__(self, field: Literal["email", "phone"]) -> None:
        super().__init__(f"an account with this {field} already exists")
        self.field = field


# ----------------------------------------------------------------------
# validation
# ----------------------------------------------------------------------
def normalize_email(raw: str) -> str:
    email = raw.strip().lower()
    if len(email) > MAX_EMAIL or not _EMAIL.match(email):
        raise AuthInputError("enter a valid email address")
    return email


def normalize_phone(raw: str) -> str:
    """Digits only: spaces, dashes, dots and brackets are dropped, and so is
    an optional leading ``+``; 10 to 15 digits remain."""
    match = _PHONE.match(_PHONE_SEPARATORS.sub("", raw.strip()))
    low, high = PHONE_DIGITS
    if match is None or not low <= len(match.group(1)) <= high:
        raise AuthInputError(f"enter a phone number of {low} to {high} digits, optionally starting with +")
    return match.group(1)


def mask_phone(phone: str) -> str:
    """Every digit but the last four hidden: ``******3210``."""
    return "*" * max(len(phone) - 4, 0) + phone[-4:]


def check_password(password: str) -> str:
    if len(password) < MIN_PASSWORD:
        raise AuthInputError(f"the password must be at least {MIN_PASSWORD} characters")
    if len(password) > MAX_PASSWORD:
        raise AuthInputError(f"the password must be at most {MAX_PASSWORD} characters")
    return password


def check_name(raw: str) -> str:
    name = " ".join(raw.split())
    if not name or len(name) > MAX_NAME:
        raise AuthInputError(f"enter your name (1 to {MAX_NAME} characters)")
    return name


def role_for(email: str, settings: Settings) -> Role:
    operator = settings.operator_email
    if operator and hmac.compare_digest(email.encode(), operator.encode()):
        return "operator"
    return "user"


# ----------------------------------------------------------------------
# passwords and tokens
# ----------------------------------------------------------------------
def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, length: int) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=length, maxmem=64 * 1024 * 1024
    )


def hash_password(password: str) -> str:
    """``scrypt$n$r$p$salt$hash``, salt and hash in base64."""
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = _scrypt(password, salt, _SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_LEN)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = _scrypt(password, base64.b64decode(salt), int(n), int(r), int(p), len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


_dummy_hash: str | None = None


def burn_password_check(password: str) -> None:
    """Spend as long as a real check, so an unknown account answers no faster
    than a wrong password."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password(secrets.token_urlsafe(16))
    verify_password(password, _dummy_hash)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def same_secret(supplied: str, expected: str) -> bool:
    """Constant-time comparison that also accepts non-ASCII input."""
    return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


# ----------------------------------------------------------------------
# principals
# ----------------------------------------------------------------------
@dataclass(frozen=True)
class User:
    user_id: str
    email: str
    phone: str
    full_name: str
    created_at: str


@dataclass(frozen=True)
class Principal:
    """Who made a request: a signed-in user, or the operator API token."""

    role: Role
    user: User | None = None

    @property
    def subject(self) -> str:
        return self.user.user_id if self.user is not None else API_TOKEN_SUBJECT

    @property
    def is_operator(self) -> bool:
        return self.role == "operator"


# ----------------------------------------------------------------------
# persistence
# ----------------------------------------------------------------------
class AuthStore:
    """Users, sessions and run ownership, in the run database."""

    def __init__(self, store: RunStore, session_ttl_seconds: int) -> None:
        self.store = store
        self.ttl = session_ttl_seconds

    @staticmethod
    def _user(row: sqlite3.Row) -> User:
        return User(
            user_id=row["user_id"],
            email=row["email"],
            phone=row["phone"],
            full_name=row["full_name"],
            created_at=row["created_at"],
        )

    def create_user(self, email: str, phone: str, full_name: str, password_hash: str, role: Role) -> User:
        user = User(
            user_id=f"usr_{uuid.uuid4().hex[:16]}",
            email=email,
            phone=phone,
            full_name=full_name,
            created_at=utc_now(),
        )
        with self.store.transaction("write") as conn:
            # The store lock is held, so nothing registers between the checks
            # and the insert; the UNIQUE constraints back them up regardless.
            for field, value in (("email", email), ("phone", phone)):
                if conn.execute(f"SELECT 1 FROM users WHERE {field} = ?", (value,)).fetchone():
                    raise DuplicateAccountError(field)  # type: ignore[arg-type]
            try:
                conn.execute(
                    "INSERT INTO users (user_id, email, phone, full_name, password_hash, role, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (user.user_id, email, phone, full_name, password_hash, role, user.created_at),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateAccountError("email") from exc
        return user

    def find_login(self, identifier: str) -> tuple[User, str] | None:
        """The account an email or phone names, with its password hash."""
        try:
            field, value = (
                ("email", normalize_email(identifier)) if "@" in identifier else ("phone", normalize_phone(identifier))
            )
        except AuthInputError:
            return None
        with self.store.transaction("read") as conn:
            row = conn.execute(f"SELECT * FROM users WHERE {field} = ?", (value,)).fetchone()
        return (self._user(row), row["password_hash"]) if row is not None else None

    def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self.store.transaction("write") as conn:
            conn.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
            conn.execute(
                "INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (token_hash(token), user_id, now + self.ttl, utc_now()),
            )
        return token

    def user_for_token(self, token: str) -> User | None:
        if not token:
            return None
        with self.store.transaction("read") as conn:
            row = conn.execute(
                "SELECT users.* FROM auth_sessions JOIN users USING (user_id)"
                " WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?",
                (token_hash(token), int(time.time())),
            ).fetchone()
        return self._user(row) if row is not None else None

    def revoke(self, token: str) -> None:
        with self.store.transaction("write") as conn:
            conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (token_hash(token),))

    def set_run_owner(self, run_id: str, subject: str) -> None:
        with self.store.transaction("write") as conn:
            conn.execute("INSERT OR IGNORE INTO run_owners (run_id, subject) VALUES (?, ?)", (run_id, subject))

    def run_owner(self, run_id: str) -> str | None:
        with self.store.transaction("read") as conn:
            row = conn.execute("SELECT subject FROM run_owners WHERE run_id = ?", (run_id,)).fetchone()
        return row["subject"] if row is not None else None
