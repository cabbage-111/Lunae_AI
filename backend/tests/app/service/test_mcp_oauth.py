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

"""The whole authorization handshake, against a server that behaves like one.

No fixture invents a shortcut: the fake MCP endpoint answers 401 exactly the way
``api.mail.qq.com`` does, the fake authorization server serves the same two
well-known documents, and the browser step is a real HTTP redirect that lands on
the real loopback listener. What is skipped is only the human clicking consent.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.service import mcp_oauth


class _FakeOAuth(BaseHTTPRequestHandler):
    """One server playing MCP endpoint, resource metadata, AS and token endpoint."""

    issued: dict = {}
    registrations: dict = {}

    def log_message(self, *args) -> None:
        return

    def _json(self, payload: dict, status: int = 200, headers=None) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.path == "/mcp":
            # The refusal that starts everything.
            self._json(
                {"error": "unauthorized"},
                status=401,
                headers={
                    "WWW-Authenticate": (
                        'Bearer realm="Fake Service", '
                        f'resource_metadata="{self.base}/.well-known/oauth-protected-resource"'
                    )
                },
            )
            return
        if self.path == "/open":
            # A server with nothing to authorize: probe must leave it alone.
            self._json({"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})
            return
        if self.path == "/basic":
            # 401 without a bearer challenge: not a flow this can drive.
            self._json(
                {"error": "unauthorized"},
                status=401,
                headers={"WWW-Authenticate": 'Basic realm="Fake"'},
            )
            return
        if self.path == "/register":
            body = json.loads(raw)
            _FakeOAuth.registrations = body
            self._json({"client_id": "client-abc"}, status=201)
            return
        if self.path == "/token":
            form = dict(urllib.parse.parse_qsl(raw.decode()))
            _FakeOAuth.issued = form
            self._json(
                {
                    "access_token": "tok-live-1",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "refresh_token": "refresh-1",
                }
            )
            return
        self._json({"error": "not found"}, status=404)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/.well-known/oauth-protected-resource":
            self._json(
                {
                    "resource": f"{self.base}/mcp",
                    "authorization_servers": [self.base],
                    "scopes_supported": ["mail:read", "mail:send"],
                }
            )
            return
        if parsed.path == "/.well-known/oauth-authorization-server":
            self._json(
                {
                    "issuer": self.base,
                    "authorization_endpoint": f"{self.base}/authorize",
                    "token_endpoint": f"{self.base}/token",
                    "registration_endpoint": f"{self.base}/register",
                    "response_types_supported": ["code"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                }
            )
            return
        if parsed.path == "/authorize":
            query = dict(urllib.parse.parse_qsl(parsed.query))
            # What a consenting user does: come back with a code, same state.
            target = query["redirect_uri"]
            redirect = f"{target}?code=code-1&state={urllib.parse.quote(query['state'])}"
            self.send_response(302)
            self.send_header("Location", redirect)
            self.end_headers()
            return
        self._json({"error": "not found"}, status=404)


@pytest.fixture()
def fake_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeOAuth)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture()
def token_store(tmp_path, monkeypatch):
    store = tmp_path / "mcp-oauth.json"
    monkeypatch.setattr(mcp_oauth, "TOKEN_STORE", store)
    mcp_oauth._REFRESH_ATTEMPTED.clear()
    return store


def _wait_for_status(state: str, timeout: float = 20) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        current = mcp_oauth.status(state)
        if current["status"] != "pending":
            return current
        time.sleep(0.05)
    raise AssertionError(f"authorization stayed pending for {timeout}s")


def test_the_401_names_the_resource_metadata(fake_server, token_store):
    discovery = mcp_oauth.discover(f"{fake_server}/mcp")
    assert discovery["authorization_server"] == fake_server
    assert discovery["resource"] == f"{fake_server}/mcp"
    assert discovery["scopes"] == ["mail:read", "mail:send"]
    assert discovery["metadata"]["token_endpoint"] == f"{fake_server}/token"


def test_the_full_handshake_writes_a_bearer_header(fake_server, token_store):
    received: list[str] = []

    started = mcp_oauth.start(
        f"{fake_server}/mcp", on_authorized=received.append
    )

    # The browser step, minus the human.
    urllib.request.urlopen(started["authorize_url"], timeout=10).read()

    assert _wait_for_status(started["state"]) == {
        "status": "authorized",
        "detail": "",
    }
    assert received == ["tok-live-1"]
    assert mcp_oauth.bearer_headers(f"{fake_server}/mcp") == {
        "Authorization": "Bearer tok-live-1"
    }

    stored = json.loads(token_store.read_text())
    assert stored[f"{fake_server}/mcp"]["refresh_token"] == "refresh-1"


def test_pkce_and_resource_travel_with_the_authorize_request(
    fake_server, token_store
):
    started = mcp_oauth.start(f"{fake_server}/mcp")
    query = dict(
        urllib.parse.parse_qsl(
            urllib.parse.urlsplit(started["authorize_url"]).query
        )
    )
    urllib.request.urlopen(started["authorize_url"], timeout=10).read()
    _wait_for_status(started["state"])

    assert query["code_challenge_method"] == "S256"
    assert query["resource"] == f"{fake_server}/mcp"
    assert query["scope"] == "mail:read mail:send"
    assert "code_challenge" in query and query["code_challenge"]
    # The verifier that proves possession reaches the token endpoint unchanged.
    assert _FakeOAuth.issued["grant_type"] == "authorization_code"
    assert (
        mcp_oauth.challenge_for(_FakeOAuth.issued["code_verifier"])
        == query["code_challenge"]
    )


def test_registration_declares_a_public_pkce_client(fake_server, token_store):
    mcp_oauth.start(f"{fake_server}/mcp")
    registration = _FakeOAuth.registrations
    assert registration["token_endpoint_auth_method"] == "none"
    assert registration["grant_types"] == [
        "authorization_code",
        "refresh_token",
    ]
    redirect = registration["redirect_uris"][0]
    assert redirect.startswith("http://127.0.0.1:")
    assert redirect.endswith("/callback")


def test_a_server_that_does_not_ask_cannot_be_authorized(
    fake_server, token_store
):
    with pytest.raises(mcp_oauth.McpOAuthError) as raised:
        mcp_oauth.discover(
            f"{fake_server}/.well-known/oauth-protected-resource"
        )
    assert "401" in str(raised.value)


def test_an_expired_token_is_not_reported_as_usable(token_store):
    mcp_oauth.save_token(
        "https://x/mcp",
        {"access_token": "old", "expires_at": int(time.time()) - 5},
    )
    assert mcp_oauth.access_token_for("https://x/mcp") is None
    assert mcp_oauth.bearer_headers("https://x/mcp") == {}


def test_probe_reports_which_authorization_a_server_wants(
    fake_server, token_store
):
    """The renderer's button has four possible jobs; the probe names the one."""
    found = mcp_oauth.probe(f"{fake_server}/mcp")
    assert found["outcome"] == "auth_required"
    assert found["authorization_server"] == fake_server
    assert found["scopes"] == ["mail:read", "mail:send"]


def test_probe_leaves_a_working_server_alone(fake_server, token_store):
    assert mcp_oauth.probe(f"{fake_server}/open")["outcome"] == "open"


def test_probe_refuses_to_pretend_a_non_bearer_server_is_authorizable(
    fake_server, token_store
):
    found = mcp_oauth.probe(f"{fake_server}/basic")
    assert found["outcome"] == "unsupported"
    assert "unsupported scheme" in found["detail"]


def test_probe_reports_an_unreachable_server_without_raising(token_store):
    """A stdio server is not listening yet; that is not an install failure."""
    found = mcp_oauth.probe("http://127.0.0.1:9/mcp")
    assert found["outcome"] == "unreachable"
    assert found["detail"]


def test_an_expired_token_is_refreshed_instead_of_asking_again(
    fake_server, token_store
):
    """The point of storing a refresh token: the user authorizes once, not hourly."""
    resource = f"{fake_server}/mcp"
    mcp_oauth.save_token(
        resource,
        {
            "access_token": "stale",
            "refresh_token": "refresh-1",
            "client_id": "client-abc",
            "token_endpoint": f"{fake_server}/token",
            "expires_at": int(time.time()) - 10,
        },
    )

    assert mcp_oauth.ensure_access_token(resource) == "tok-live-1"
    assert _FakeOAuth.issued["grant_type"] == "refresh_token"
    assert _FakeOAuth.issued["refresh_token"] == "refresh-1"
    # The renewed token is stored, so the next read needs no network at all.
    assert mcp_oauth.access_token_for(resource) == "tok-live-1"


def test_a_token_that_cannot_be_refreshed_is_reported_as_missing(token_store):
    resource = "https://x/mcp"
    mcp_oauth.save_token(
        resource,
        {"access_token": "stale", "expires_at": int(time.time()) - 10},
    )
    assert mcp_oauth.ensure_access_token(resource) is None


def test_a_failed_refresh_is_not_retried_on_every_read(
    fake_server, token_store, monkeypatch
):
    """mcp.json is read for the connector list too; a dead endpoint must not slow it."""
    resource = f"{fake_server}/mcp"
    mcp_oauth.save_token(
        resource,
        {
            "access_token": "stale",
            "refresh_token": "refresh-1",
            "client_id": "client-abc",
            "token_endpoint": f"{fake_server}/token",
            "expires_at": int(time.time()) - 10,
        },
    )

    calls = {"n": 0}
    real = mcp_oauth.refresh_access_token

    def counting(record):
        calls["n"] += 1
        raise mcp_oauth.McpOAuthError("endpoint is down")

    monkeypatch.setattr(mcp_oauth, "refresh_access_token", counting)
    assert mcp_oauth.ensure_access_token(resource) is None
    assert mcp_oauth.ensure_access_token(resource) is None
    assert calls["n"] == 1
    monkeypatch.setattr(mcp_oauth, "refresh_access_token", real)


def test_apply_tokens_touches_only_the_servers_it_knows(token_store):
    mcp_oauth.save_token(
        "https://known/mcp",
        {"access_token": "tok-1", "expires_at": int(time.time()) + 3600},
    )
    config = {
        "mcpServers": {
            "known": {"type": "streamable_http", "url": "https://known/mcp"},
            "stranger": {
                "type": "streamable_http",
                "url": "https://other/mcp",
            },
        }
    }

    result = mcp_oauth.apply_tokens(config)

    assert result["mcpServers"]["known"]["headers"] == {
        "Authorization": "Bearer tok-1"
    }
    assert "headers" not in result["mcpServers"]["stranger"]
