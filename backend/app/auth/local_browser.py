# ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========
"""Expiring browser credentials for the Desktop-local control plane.

The packaged Desktop renderer receives the control capability through Electron
IPC. A browser tab has no IPC, so it presents a signed, expiring token instead:
the Brain prints one at startup and the page stores it locally. Both
credentials land on the same dependency, ``require_local_control_principal``,
and both keep the same properties:

* the secret never reaches a subprocess environment or a config file that a
  model-controlled tool can read, and only loopback clients may use it;
* the secret is compared in constant time and is not accepted by a route that
  forwards credentials to Cloud (``run_sync.middleware`` reads only the
  ``Authorization`` header, so the local token stays local);
* the caller is authenticated, not merely "a header was present".

Enable with ``EIGENT_LOCAL_BROWSER_AUTH=1``. The signing key is persisted under
``~/.eigent`` so a paired page keeps working across Brain restarts. That is the
convenient setting, not the strongest one: any process running as the same user
can read that file. ``EIGENT_LOCAL_BROWSER_EPHEMERAL_KEY=1`` keeps the key in
memory instead, which matches the Desktop capability (per launch, never on
disk) and costs one re-pairing per restart.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import pathlib
import secrets
import time

from app.auth.brain_auth import set_brain_auth_provider
from app.auth.interface import IAuthProvider
from app.auth.local_control import is_loopback_host

logger = logging.getLogger("auth.local_browser")

LOCAL_BROWSER_AUTH_ENV = "EIGENT_LOCAL_BROWSER_AUTH"
LOCAL_BROWSER_TOKEN_HEADER = "X-Eigent-Local-Control"
LOCAL_BROWSER_TOKEN_TTL_ENV = "EIGENT_LOCAL_BROWSER_TOKEN_TTL"
LOCAL_BROWSER_KEY_ENV = "EIGENT_LOCAL_BROWSER_KEY"
LOCAL_BROWSER_EPHEMERAL_KEY_ENV = "EIGENT_LOCAL_BROWSER_EPHEMERAL_KEY"
LOCAL_BROWSER_AUTOPAIR_ENV = "EIGENT_LOCAL_BROWSER_AUTOPAIR"
LOCAL_BROWSER_PRINCIPAL = "local-browser"

DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
_TOKEN_VERSION = 1
_TOKEN_PREFIX = "lc1"
_TOKEN_AUDIENCE = "local-control"
_KEY_FILE = pathlib.Path(".eigent") / "local-control-key"
_TOKEN_FILE_NAME = "local-control-token"
_TRUTHY = {"1", "true", "yes", "on"}


def browser_auth_enabled() -> bool:
    """Return whether this Brain accepts browser control credentials."""

    return (
        os.environ.get(LOCAL_BROWSER_AUTH_ENV, "").strip().lower() in _TRUTHY
    )


def token_ttl_seconds() -> int:
    raw = os.environ.get(LOCAL_BROWSER_TOKEN_TTL_ENV, "").strip()
    if not raw:
        return DEFAULT_TOKEN_TTL_SECONDS
    try:
        ttl = int(raw)
    except ValueError:
        logger.warning(
            "Ignoring %s=%r; using %s seconds",
            LOCAL_BROWSER_TOKEN_TTL_ENV,
            raw,
            DEFAULT_TOKEN_TTL_SECONDS,
        )
        return DEFAULT_TOKEN_TTL_SECONDS
    return ttl if ttl > 0 else DEFAULT_TOKEN_TTL_SECONDS


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(key: bytes, body: str) -> str:
    digest = hmac.new(key, body.encode("ascii"), hashlib.sha256).digest()
    return _b64encode(digest)


def key_path() -> pathlib.Path:
    configured = os.environ.get(LOCAL_BROWSER_KEY_ENV, "").strip()
    if configured:
        return pathlib.Path(configured).expanduser()
    return pathlib.Path.home() / _KEY_FILE


def autopair_enabled() -> bool:
    """Return whether the issued token is also written for local dev servers.

    Manual pairing keeps the credential in the startup log only, so a human has
    to hand it to the page. A dev server on the same machine can read a 0600
    file instead, which removes that step at the cost of trusting local
    processes — the same trust already extended to the signing key beside it.
    """

    return (
        browser_auth_enabled()
        and os.environ.get(LOCAL_BROWSER_AUTOPAIR_ENV, "").strip().lower()
        in _TRUTHY
    )


def token_file_path(path: pathlib.Path | None = None) -> pathlib.Path:
    """Return where the autopaired token is published, beside the key."""

    return (path or key_path()).parent / _TOKEN_FILE_NAME


def publish_token_file(token: str, path: pathlib.Path | None = None) -> bool:
    """Write the current token for a local dev server; never fatal."""

    target = token_file_path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(
            target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
        )
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(token)
        os.chmod(target, 0o600)
    except OSError:
        logger.warning("Could not publish the browser control token to %s", target)
        return False
    return True


def load_or_create_key(path: pathlib.Path | None = None) -> bytes:
    """Return the token signing key, persisting a new one with mode 0600.

    A key file that cannot be read or written is not fatal: the Brain keeps an
    in-memory key for this process, which only costs the user one re-pairing.
    """

    if os.environ.get(LOCAL_BROWSER_EPHEMERAL_KEY_ENV, "").strip().lower() in (
        _TRUTHY
    ):
        return secrets.token_bytes(32)

    target = path or key_path()
    try:
        stored = target.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        stored = ""
    except (OSError, UnicodeDecodeError):
        logger.warning("Unreadable browser control key at %s", target)
        stored = ""
    if stored:
        try:
            key = _b64decode(stored)
        except (binascii.Error, ValueError):
            key = b""
        if len(key) >= 32:
            return key
        logger.warning(
            "Ignoring malformed browser control key at %s; generating a new "
            "one. Previously paired pages must pair again.",
            target,
        )

    key = secrets.token_bytes(32)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w", encoding="ascii") as stream:
            stream.write(_b64encode(key))
    except OSError:
        logger.warning(
            "Could not persist the browser control key at %s; this process "
            "keeps an in-memory key instead",
            target,
            exc_info=True,
        )
    return key


def issue_browser_token(
    key: bytes,
    *,
    now: float | None = None,
    ttl_seconds: int | None = None,
) -> tuple[str, int]:
    """Return a signed control token and its expiry (epoch seconds)."""

    ttl = token_ttl_seconds() if ttl_seconds is None else ttl_seconds
    expires_at = int(time.time() if now is None else now) + ttl
    payload = {
        "v": _TOKEN_VERSION,
        "aud": _TOKEN_AUDIENCE,
        "sub": LOCAL_BROWSER_PRINCIPAL,
        "exp": expires_at,
    }
    body = _b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    )
    return f"{_TOKEN_PREFIX}.{body}.{_sign(key, body)}", expires_at


def read_browser_token(
    token: str | None, key: bytes, *, now: float | None = None
) -> dict | None:
    """Return the payload of a valid, unexpired token, otherwise None."""

    prefix, _, remainder = (token or "").partition(".")
    if prefix != _TOKEN_PREFIX:
        return None
    body, _, signature = remainder.partition(".")
    if not body or not signature:
        return None
    try:
        expected = _sign(key, body)
    except UnicodeEncodeError:
        return None
    if not hmac.compare_digest(signature.encode(), expected.encode()):
        return None
    try:
        payload = json.loads(_b64decode(body))
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("v") != _TOKEN_VERSION:
        return None
    if payload.get("aud") != _TOKEN_AUDIENCE:
        return None
    expires_at = payload.get("exp")
    if not isinstance(expires_at, int):
        return None
    if expires_at <= (time.time() if now is None else now):
        return None
    return payload


def _presented_token(headers: dict[str, str]) -> str:
    presented = headers.get(LOCAL_BROWSER_TOKEN_HEADER.lower(), "").strip()
    if presented:
        return presented
    authorization = headers.get("authorization", "")
    scheme, _, value = authorization.partition(" ")
    value = value.strip()
    if scheme.lower() == "bearer" and value.startswith(f"{_TOKEN_PREFIX}."):
        # Only our own token shape is read here. A Cloud bearer keeps going to
        # the sync middleware untouched and never authenticates local control.
        return value
    return ""


class LocalBrowserAuth(IAuthProvider):
    """Authenticate a browser page that holds a valid local control token.

    Routes outside the control plane keep the previous local-trust baseline, so
    enabling this provider cannot break traffic that used to work with
    ``NoneAuth``. ``authenticated`` is what separates the two postures:
    ``require_local_control_principal`` accepts only a verified identity.
    """

    def __init__(self, key: bytes) -> None:
        self._key = key

    async def authenticate(self, scope: dict) -> dict[str, str | bool]:
        headers = {
            str(name).lower(): str(value)
            for name, value in (scope.get("headers") or {}).items()
        }
        presented = _presented_token(headers)
        anonymous: dict[str, str | bool] = {
            "user_id": "local",
            "tenant_id": "default",
            "credential_present": bool(presented),
            "authenticated": False,
        }
        if not presented:
            return anonymous
        if not is_loopback_host(scope.get("client_host")):
            return anonymous
        if read_browser_token(presented, self._key) is None:
            return anonymous
        return {
            "user_id": LOCAL_BROWSER_PRINCIPAL,
            "tenant_id": "default",
            "credential_present": True,
            "authenticated": True,
        }


_installed_token: str | None = None


def install_local_browser_auth() -> str | None:
    """Install the browser provider once and return its pairing token.

    Idempotent: ``python main.py`` imports this module through two module
    objects, so startup can legitimately ask twice. The second call must not
    replace the provider or issue a different token.
    """

    global _installed_token
    if not browser_auth_enabled():
        return None
    if _installed_token is None:
        key = load_or_create_key()
        set_brain_auth_provider(LocalBrowserAuth(key))
        _installed_token, expires_at = issue_browser_token(key)
        logger.info(
            "Browser control auth enabled; token valid until %s",
            time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(expires_at)),
        )
        if autopair_enabled() and publish_token_file(_installed_token):
            logger.warning(
                "Browser control autopair enabled; token also written to %s",
                token_file_path(),
            )
    return _installed_token
