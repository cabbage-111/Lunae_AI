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
"""Browser control credentials behave like the Desktop capability.

Both credentials reach the same dependency and both are loopback-only, so the
cases that matter are: a valid token authenticates, and everything else stays
anonymous instead of failing open.
"""

from __future__ import annotations

import stat

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.auth import (
    LOCAL_BROWSER_TOKEN_HEADER,
    LocalBrowserAuth,
    issue_browser_token,
    read_browser_token,
    require_local_control_principal,
    with_brain_auth_provider,
)
from app.auth.local_browser import load_or_create_key

_KEY = b"k" * 32


def _request(headers: dict[str, str], host: str = "127.0.0.1") -> Request:
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/spaces/space-1/permission-profile",
            "raw_path": b"/spaces/space-1/permission-profile",
            "query_string": b"",
            "headers": [
                (name.lower().encode(), value.encode())
                for name, value in headers.items()
            ],
            "client": (host, 51234),
            "server": ("127.0.0.1", 5001),
            "app": None,
        }
    )


def test_token_round_trip_and_rejections():
    token, expires_at = issue_browser_token(_KEY, ttl_seconds=60)
    payload = read_browser_token(token, _KEY)

    assert payload is not None
    assert payload["exp"] == expires_at
    assert payload["sub"] == "local-browser"

    # Expired.
    assert read_browser_token(token, _KEY, now=expires_at + 1) is None
    # Wrong key.
    assert read_browser_token(token, b"j" * 32) is None
    # Tampered signature.
    body, _, signature = token.rpartition(".")
    flipped = "A" if signature[0] != "A" else "B"
    assert read_browser_token(f"{body}.{flipped}{signature[1:]}", _KEY) is None
    # Foreign prefix and empty input.
    assert read_browser_token(f"xx1{token[3:]}", _KEY) is None
    assert read_browser_token("", _KEY) is None
    assert read_browser_token(None, _KEY) is None


@pytest.mark.asyncio
async def test_provider_authenticates_only_valid_loopback_tokens():
    provider = LocalBrowserAuth(_KEY)
    token, _ = issue_browser_token(_KEY, ttl_seconds=60)

    anonymous = await provider.authenticate(
        {"headers": {}, "client_host": "127.0.0.1"}
    )
    assert anonymous["authenticated"] is False

    verified = await provider.authenticate(
        {
            "headers": {LOCAL_BROWSER_TOKEN_HEADER.lower(): token},
            "client_host": "127.0.0.1",
        }
    )
    assert verified["authenticated"] is True
    assert verified["user_id"] == "local-browser"

    remote = await provider.authenticate(
        {
            "headers": {LOCAL_BROWSER_TOKEN_HEADER.lower(): token},
            "client_host": "10.1.2.3",
        }
    )
    assert remote["authenticated"] is False

    invalid = await provider.authenticate(
        {
            "headers": {
                LOCAL_BROWSER_TOKEN_HEADER.lower(): f"lc1.stub.{token}"
            },
            "client_host": "127.0.0.1",
        }
    )
    assert invalid["authenticated"] is False


@pytest.mark.asyncio
async def test_provider_accepts_its_own_token_in_the_authorization_header():
    provider = LocalBrowserAuth(_KEY)
    token, _ = issue_browser_token(_KEY, ttl_seconds=60)

    identity = await provider.authenticate(
        {
            "headers": {"authorization": f"Bearer {token}"},
            "client_host": "127.0.0.1",
        }
    )

    assert identity["authenticated"] is True


@pytest.mark.asyncio
async def test_control_dependency_requires_a_verified_identity():
    token, _ = issue_browser_token(_KEY, ttl_seconds=60)
    with with_brain_auth_provider(LocalBrowserAuth(_KEY)):
        principal = await require_local_control_principal(
            _request({LOCAL_BROWSER_TOKEN_HEADER: token})
        )
        assert principal.kind == "brain_user"
        assert principal.user_id == "local-browser"

        with pytest.raises(HTTPException) as error:
            await require_local_control_principal(_request({}))

    assert error.value.status_code == 401
    assert error.value.detail["code"] == "brain_auth_required_for_control"


@pytest.mark.asyncio
async def test_a_cloud_bearer_does_not_authenticate_local_control():
    """The sync middleware sees `Authorization`; control must not trust it."""

    with with_brain_auth_provider(LocalBrowserAuth(_KEY)):
        with pytest.raises(HTTPException) as error:
            await require_local_control_principal(
                _request({"Authorization": "Bearer cloud-session-token"})
            )

    assert error.value.status_code == 401


def test_key_is_persisted_once_with_owner_only_permissions(tmp_path):
    path = tmp_path / "nested" / "local-control-key"

    first = load_or_create_key(path)
    second = load_or_create_key(path)

    assert first == second
    assert len(first) == 32
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_ephemeral_key_never_touches_the_disk(tmp_path, monkeypatch):
    monkeypatch.setenv("EIGENT_LOCAL_BROWSER_EPHEMERAL_KEY", "1")
    path = tmp_path / "local-control-key"

    first = load_or_create_key(path)
    second = load_or_create_key(path)

    assert first != second
    assert not path.exists()


def test_autopair_publishes_the_token_beside_the_key(tmp_path, monkeypatch):
    """A dev server reads this file instead of a human copying a link."""

    from app.auth.local_browser import (
        install_local_browser_auth,
        read_browser_token,
        token_file_path,
    )

    monkeypatch.setenv("EIGENT_LOCAL_BROWSER_AUTH", "1")
    monkeypatch.setenv("EIGENT_LOCAL_BROWSER_AUTOPAIR", "1")
    monkeypatch.setenv(
        "EIGENT_LOCAL_BROWSER_KEY", str(tmp_path / "local-control-key")
    )
    monkeypatch.setattr("app.auth.local_browser._installed_token", None)

    token = install_local_browser_auth()

    published = token_file_path()
    assert published == tmp_path / "local-control-token"
    assert published.read_text(encoding="ascii").strip() == token
    assert stat.S_IMODE(published.stat().st_mode) == 0o600
    assert read_browser_token(token, load_or_create_key()) is not None


def test_autopair_is_off_unless_asked_for(tmp_path, monkeypatch):
    from app.auth.local_browser import (
        install_local_browser_auth,
        token_file_path,
    )

    monkeypatch.setenv("EIGENT_LOCAL_BROWSER_AUTH", "1")
    monkeypatch.delenv("EIGENT_LOCAL_BROWSER_AUTOPAIR", raising=False)
    monkeypatch.setenv(
        "EIGENT_LOCAL_BROWSER_KEY", str(tmp_path / "local-control-key")
    )
    monkeypatch.setattr("app.auth.local_browser._installed_token", None)

    assert install_local_browser_auth() is not None
    assert not token_file_path().exists()


def test_paired_browser_reaches_a_real_control_route(tmp_path, monkeypatch):
    """The production route, the real dependency, and a browser token."""

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.auth.brain_auth import (
        get_brain_auth_provider,
        set_brain_auth_provider,
    )
    from app.auth.local_browser import install_local_browser_auth
    from app.router import register_routers
    from app.run_journal import SQLiteRunJournal

    monkeypatch.delenv("EIGENT_RUNTIME", raising=False)
    monkeypatch.delenv("EIGENT_LOCAL_CONTROL_CAPABILITY", raising=False)
    monkeypatch.setenv("EIGENT_LOCAL_BROWSER_AUTH", "1")
    monkeypatch.setenv(
        "EIGENT_LOCAL_BROWSER_KEY", str(tmp_path / "local-control-key")
    )
    # The provider and the issued token are process-wide, so restore them or
    # every later test would run against a configured Brain.
    monkeypatch.setattr("app.auth.local_browser._installed_token", None)
    previous_provider = get_brain_auth_provider()
    try:
        token = install_local_browser_auth()
        assert token is not None

        with SQLiteRunJournal(tmp_path / "journal.sqlite3") as journal:
            monkeypatch.setattr(
                "app.controller.permission_controller.get_default_run_journal",
                lambda: journal,
            )
            app = FastAPI()
            register_routers(app)
            with TestClient(app, client=("127.0.0.1", 50000)) as client:
                paired = client.get(
                    "/spaces/space-1/permission-profile",
                    headers={LOCAL_BROWSER_TOKEN_HEADER: token},
                )
                unpaired = client.get("/spaces/space-1/permission-profile")
                forged = client.get(
                    "/spaces/space-1/permission-profile",
                    headers={
                        LOCAL_BROWSER_TOKEN_HEADER: f"lc1.forged.{token}"
                    },
                )
    finally:
        set_brain_auth_provider(previous_provider)

    assert paired.status_code == 200
    assert paired.json()["profile_name"] == "request_approval"
    assert unpaired.status_code == 401
    assert unpaired.json()["detail"]["code"] == (
        "brain_auth_required_for_control"
    )
    assert forged.status_code == 401
