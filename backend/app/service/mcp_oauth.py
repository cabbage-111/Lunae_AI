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

"""Authorization for remote MCP servers (RFC 9728 + OAuth 2.1 + PKCE).

Most remote catalogue entries are not "url plus an API key". They answer

    401 Unauthorized
    WWW-Authenticate: Bearer realm="QQMail Service",
        resource_metadata="https://api.mail.qq.com/.well-known/oauth-protected-resource"

and expect the client to run a browser authorization: discover the authorization
server, register itself, send the user to a consent page, receive a code on a
loopback redirect, and trade it for a bearer token. That is the "跳转授权" step;
no amount of header plumbing substitutes for it.

Flow, all of it discoverable from the URL alone:

    server_url
      -> /.well-known/oauth-protected-resource   (which AS, which scopes)
      -> AS /.well-known/oauth-authorization-server (authorize/token/register)
      -> POST registration_endpoint              (dynamic client registration)
      -> authorize_endpoint?code_challenge=...    (browser, user consents)
      -> GET http://127.0.0.1:<port>/callback?code=...
      -> POST token_endpoint                     (code + PKCE verifier)
      -> Authorization: Bearer <token>           (what mcp.json finally holds)

The token is stored per resource in ``~/.eigent/mcp-oauth.json``. Refreshing it
before every connect is deliberately *not* done here: a stale token surfaces as
a 401, and `describe_failure` turns that into "reauthorize", which is a question
the user can answer, unlike a silent reconnect loop.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN_STORE = Path.home() / ".eigent" / "mcp-oauth.json"
HTTP_TIMEOUT = 20
# A probe runs while the user is waiting on a click, so a dead URL must not hold
# the button for the full timeout: "no answer" and "slow answer" both mean
# "nothing to authorize here", and the install proceeds either way.
PROBE_TIMEOUT = 6
# A refresh happens inside a config read that a request is waiting on, so it is
# given less rope than a first-time exchange. A slow token endpoint must not
# turn opening the connector list into a ten-second stall.
REFRESH_TIMEOUT = 10
CLIENT_NAME = "Eigent"
CALLBACK_PATH = "/callback"


class McpOAuthError(RuntimeError):
    """The authorization cannot proceed; the message says which step."""


# ---------------------------------------------------------------- discovery


def _get_json(url: str) -> dict:
    request = urllib.request.Request(
        url, headers={"Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def _refusal(url: str, error: urllib.error.HTTPError) -> str:
    """Say what the authorization server said, not just its status code.

    `HTTP Error 403: Forbidden` reads as a network problem, while the body
    usually names the actual cause ("redirect_uri does not match any trusted
    platform"). That sentence is the difference between the user debugging
    their proxy and the user learning the server only trusts its own clients.
    """
    detail = ""
    try:
        raw = error.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            detail = raw.strip()[:200]
        else:
            if isinstance(payload, dict):
                detail = str(
                    payload.get("error_description")
                    or payload.get("error")
                    or payload.get("message")
                    or ""
                ).strip()
    except Exception:  # noqa: BLE001 - a broken body must not mask the status
        detail = ""
    host = urllib.parse.urlsplit(url).netloc or url
    if detail:
        return f"{host} refused this client ({error.code}): {detail}"
    return f"{host} refused this client ({error.code} {error.reason})"


def _post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise McpOAuthError(_refusal(url, error)) from error


def _post_form(url: str, payload: dict, timeout: float = HTTP_TIMEOUT) -> dict:
    body = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _origin(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _challenge_for(
    server_url: str, timeout: float = HTTP_TIMEOUT
) -> str | None:
    """Ask the server what it wants, by making the request it will refuse.

    The 401 is the only place the protected-resource location is announced; a
    server that answers 200 needs no authorization at all, and one that answers
    401 without WWW-Authenticate cannot be authorized by this flow.
    """
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": "0"},
            },
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        server_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()
            return None
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise McpOAuthError(
                f"{server_url} answered {error.code}; only a 401 starts authorization"
            ) from error
        return error.headers.get("WWW-Authenticate")


def _resource_metadata_url(server_url: str, challenge: str | None) -> str:
    if challenge:
        # RFC 7235 auth-param list: Bearer realm="x", resource_metadata="https://..."
        for part in challenge.split(" ", 1)[-1].split(","):
            name, _, value = part.strip().partition("=")
            if name.strip().lower() == "resource_metadata":
                return value.strip().strip('"')
    # RFC 9728 section 3.1: the well-known path is inserted after the origin.
    parts = urllib.parse.urlsplit(server_url)
    path = parts.path.rstrip("/")
    return f"{_origin(server_url)}/.well-known/oauth-protected-resource{path}"


def discover(server_url: str, timeout: float = HTTP_TIMEOUT) -> dict:
    """Return {resource, authorization_server, metadata, scopes} for a server."""
    challenge = _challenge_for(server_url, timeout)
    if challenge is None:
        raise McpOAuthError(f"{server_url} did not ask for authorization")
    if "bearer" not in challenge.lower():
        raise McpOAuthError(
            f"{server_url} wants an unsupported scheme: {challenge.split(' ')[0]}"
        )

    resource_url = _resource_metadata_url(server_url, challenge)
    resource = _get_json(resource_url)
    servers = resource.get("authorization_servers") or []
    if not servers:
        raise McpOAuthError(f"{resource_url} names no authorization server")

    issuer = servers[0]
    metadata_endpoint = (
        f"{issuer.rstrip('/')}/.well-known/oauth-authorization-server"
    )
    try:
        metadata = _get_json(metadata_endpoint)
    except urllib.error.HTTPError:
        metadata = _get_json(
            f"{issuer.rstrip('/')}/.well-known/openid-configuration"
        )

    for required in ("authorization_endpoint", "token_endpoint"):
        if not metadata.get(required):
            raise McpOAuthError(
                f"{metadata_endpoint} does not declare {required}"
            )

    return {
        "resource": resource.get("resource") or server_url,
        "authorization_server": issuer,
        "scopes": resource.get("scopes_supported") or [],
        "metadata": metadata,
    }


def probe(server_url: str) -> dict:
    """Say whether a server needs authorization, without starting any.

    The caller takes a different action for each outcome, so the outcomes are
    named rather than collapsed into a boolean:

      open            it answered a normal initialize; install it and stop.
      auth_required   it answered 401 and advertised where to authorize.
      unsupported     it answered 401, but not with a flow this can drive
                      (no WWW-Authenticate, or a scheme other than Bearer).
      unreachable     the request did not complete. Not a failure: a local
                      stdio server only listens once it is launched.
    """
    try:
        challenge = _challenge_for(server_url, PROBE_TIMEOUT)
    except McpOAuthError as error:
        return {"outcome": "unsupported", "detail": str(error)}
    except (urllib.error.URLError, OSError, ValueError) as error:
        return {"outcome": "unreachable", "detail": str(error)[:200]}
    if challenge is None:
        return {"outcome": "open", "detail": ""}

    try:
        found = discover(server_url, PROBE_TIMEOUT)
    except (
        McpOAuthError,
        urllib.error.URLError,
        OSError,
        ValueError,
    ) as error:
        return {"outcome": "unsupported", "detail": str(error)[:200]}

    return {
        "outcome": "auth_required",
        "detail": "",
        "authorization_server": found["authorization_server"],
        "scopes": found["scopes"],
    }


# ------------------------------------------------------- client registration


def register_client(metadata: dict, redirect_uri: str) -> str:
    """Dynamic client registration (RFC 7591). Returns a client_id."""
    endpoint = metadata.get("registration_endpoint")
    if not endpoint:
        raise McpOAuthError(
            "this authorization server has no registration endpoint; "
            "it needs a client_id issued by hand"
        )
    registered = _post_json(
        endpoint,
        {
            "client_name": CLIENT_NAME,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        },
    )
    client_id = registered.get("client_id")
    if not client_id:
        raise McpOAuthError(f"{endpoint} returned no client_id")
    return str(client_id)


# --------------------------------------------------------------------- PKCE


def new_verifier() -> str:
    return (
        base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    )


def challenge_for(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def authorize_url(
    metadata: dict,
    client_id: str,
    redirect_uri: str,
    state: str,
    verifier: str,
    scope: str,
) -> str:
    parts = urllib.parse.urlsplit(metadata["authorization_endpoint"])
    query = dict(urllib.parse.parse_qsl(parts.query))
    query.update(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": challenge_for(verifier),
            "code_challenge_method": "S256",
            "resource": metadata_resource(metadata),
        }
    )
    if scope:
        query["scope"] = scope
    return urllib.parse.urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            urllib.parse.urlencode(query),
            "",
        )
    )


def metadata_resource(metadata: dict) -> str:
    return metadata.get("_resource", "")


# ------------------------------------------------------------ token exchange


def exchange_code(
    metadata: dict, client_id: str, code: str, verifier: str, redirect_uri: str
) -> dict:
    token = _post_form(
        metadata["token_endpoint"],
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )
    if not token.get("access_token"):
        raise McpOAuthError("token endpoint returned no access_token")
    return token


# ------------------------------------------------------------------ storage


def load_tokens() -> dict:
    if not TOKEN_STORE.is_file():
        return {}
    try:
        data = json.loads(TOKEN_STORE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def save_token(resource: str, record: dict) -> None:
    data = load_tokens()
    data[resource] = record
    TOKEN_STORE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_STORE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    try:
        TOKEN_STORE.chmod(0o600)
    except OSError:
        pass


def access_token_for(resource: str) -> str | None:
    record = load_tokens().get(resource) or {}
    token = record.get("access_token")
    if not token:
        return None
    expires_at = record.get("expires_at")
    if (
        isinstance(expires_at, (int, float))
        and expires_at
        and expires_at < time.time()
    ):
        return None
    return str(token)


def refresh_access_token(record: dict) -> dict:
    """Trade a refresh token for a new access token.

    Without this a stored token is a one-shot: the server starts answering 401
    the moment it expires, and the only cure is another trip through the
    browser. That turns "authorize once" into "authorize every hour", which is
    the difference between a feature and a chore.
    """
    endpoint = record.get("token_endpoint")
    refresh = record.get("refresh_token")
    client_id = record.get("client_id")
    if not (endpoint and refresh and client_id):
        raise McpOAuthError(
            "this token carries no refresh grant; authorize again"
        )

    issued = _post_form(
        endpoint,
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh,
            "client_id": client_id,
        },
        timeout=REFRESH_TIMEOUT,
    )
    if not issued.get("access_token"):
        raise McpOAuthError("refresh returned no access_token")
    lifetime = int(issued.get("expires_in") or 3600)
    return {
        **record,
        "access_token": issued["access_token"],
        # A server may or may not rotate the refresh token; keeping the old one
        # when it does not is required, since the new one would be absent.
        "refresh_token": issued.get("refresh_token") or refresh,
        "token_type": issued.get(
            "token_type", record.get("token_type", "Bearer")
        ),
        "scope": issued.get("scope", record.get("scope", "")),
        "issued_at": int(time.time()),
        "expires_at": int(time.time()) + lifetime,
    }


# A refresh that failed is not retried on every read: mcp.json is read for the
# connector list as well as for a connection, and a dead token endpoint would
# otherwise add its timeout to every one of those calls.
_REFRESH_ATTEMPTED: dict[str, float] = {}
_REFRESH_LOCK = threading.Lock()
REFRESH_RETRY_SECONDS = 60


def ensure_access_token(resource: str) -> str | None:
    """A usable token for this server, refreshing it when it has expired."""
    token = access_token_for(resource)
    if token:
        return token

    record = load_tokens().get(resource)
    if not record:
        return None

    now = time.time()
    with _REFRESH_LOCK:
        if now - _REFRESH_ATTEMPTED.get(resource, 0.0) < REFRESH_RETRY_SECONDS:
            return None
        _REFRESH_ATTEMPTED[resource] = now

    try:
        fresh = refresh_access_token(record)
    except (McpOAuthError, urllib.error.URLError, OSError, ValueError):
        return None
    save_token(resource, fresh)
    return fresh["access_token"]


def apply_tokens(config: dict) -> dict:
    """Rewrite the Authorization header of every server we hold a token for.

    ``mcp.json`` stores the bearer as it was at authorization time. An expired
    snapshot is a 401 with nothing in it to explain why, so the token is renewed
    here -- before a client reads the config, not after it fails.
    """
    known = load_tokens()
    servers = config.get("mcpServers")
    if not isinstance(servers, dict):
        return config
    for server in servers.values():
        if not isinstance(server, dict):
            continue
        url = str(server.get("url") or "")
        if url not in known:
            continue
        token = ensure_access_token(url)
        if not token:
            continue
        headers = dict(server.get("headers") or {})
        headers["Authorization"] = f"Bearer {token}"
        server["headers"] = headers
    return config


# --------------------------------------------------------------- callback


@dataclass
class _Pending:
    state: str
    server_url: str
    redirect_uri: str
    verifier: str
    client_id: str
    metadata: dict
    status: str = "pending"
    detail: str = ""


class CallbackServer:
    """A loopback listener that exists only to receive one code.

    Port 0 lets the OS pick a free port, which is why the redirect URI has to be
    decided before the authorize URL is built -- and why the listener must be up
    before the browser opens, or a fast redirect is lost.
    """

    def __init__(self) -> None:
        self.result: dict | None = None
        self._event = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlsplit(self.path)
                params = dict(urllib.parse.parse_qsl(parsed.query))
                outer.result = params
                body = (
                    "<html><meta charset='utf-8'><body style='font-family:system-ui;"
                    "padding:48px;text-align:center'><h2>授权完成</h2>"
                    "<p>可以关闭这个窗口，回到 Eigent 继续。</p></body></html>"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                outer._event.set()

            def log_message(self, *args) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self.redirect_uri = f"http://127.0.0.1:{self.port}{CALLBACK_PATH}"
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True
        )

    def __enter__(self) -> CallbackServer:
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()

    def wait(self, timeout: float = 300) -> dict:
        if not self._event.wait(timeout):
            raise McpOAuthError(
                "authorization timed out before the browser returned"
            )
        return self.result or {}


# ---------------------------------------------------------------- the flow

_FLOWS: dict[str, _Pending] = {}
_LOCK = threading.Lock()


def status(state: str) -> dict:
    with _LOCK:
        flow = _FLOWS.get(state)
    if not flow:
        return {"status": "unknown", "detail": "no such authorization"}
    return {"status": flow.status, "detail": flow.detail}


def start(
    server_url: str, scope: str = "", on_authorized=None, wait: float = 300
) -> dict:
    """Begin authorization. Returns the URL to open; completion runs in a thread.

    The caller opens the browser and polls `status`. Doing the waiting in a
    background thread keeps the HTTP handler from blocking for minutes while a
    human scans a QR code. `on_authorized(token)` runs once the token exists, so
    the caller can write the config without the token ever crossing the renderer.

    `wait` is how long the listener stays open. Five minutes is enough for a
    human who is already looking at the browser; a test that prints the URL into
    a chat window needs longer, and hard-coding it would make that impossible.
    """
    discovery = discover(server_url)
    metadata = dict(discovery["metadata"])
    metadata["_resource"] = discovery["resource"]
    callback = CallbackServer()
    callback.__enter__()
    try:
        client_id = register_client(metadata, callback.redirect_uri)
    except Exception:
        callback.__exit__(None, None, None)
        raise

    verifier = new_verifier()
    state = secrets.token_urlsafe(24)
    flow = _Pending(
        state=state,
        server_url=server_url,
        redirect_uri=callback.redirect_uri,
        verifier=verifier,
        client_id=client_id,
        metadata=metadata,
    )
    with _LOCK:
        _FLOWS[state] = flow

    url = authorize_url(
        metadata,
        client_id,
        callback.redirect_uri,
        state,
        verifier,
        scope or " ".join(discovery["scopes"]),
    )

    def run() -> None:
        try:
            params = callback.wait(timeout=wait)
            if params.get("error"):
                raise McpOAuthError(
                    f"{params['error']}: {params.get('error_description', '')}".strip()
                )
            if params.get("state") != flow.state:
                raise McpOAuthError(
                    "state mismatch; the callback was not ours"
                )
            code = params.get("code")
            if not code:
                raise McpOAuthError("callback carried no code")
            token = exchange_code(
                metadata, client_id, code, verifier, callback.redirect_uri
            )
            record = {
                "access_token": token["access_token"],
                "refresh_token": token.get("refresh_token"),
                "token_type": token.get("token_type", "Bearer"),
                "scope": token.get("scope", ""),
                "client_id": client_id,
                "token_endpoint": metadata["token_endpoint"],
                "issued_at": int(time.time()),
                "expires_at": int(time.time()) + int(token["expires_in"])
                if token.get("expires_in")
                else None,
            }
            save_token(flow.server_url, record)
            if on_authorized is not None:
                on_authorized(record["access_token"])
            flow.status = "authorized"
        except Exception as error:  # noqa: BLE001
            flow.status = "error"
            flow.detail = str(error)
        finally:
            callback.__exit__(None, None, None)

    threading.Thread(target=run, daemon=True).start()
    flow.status = "pending"
    return {"authorize_url": url, "state": state}


def bearer_headers(server_url: str) -> dict[str, str]:
    """The header mcp.json needs, or an empty map when unauthenticated."""
    token = access_token_for(server_url)
    return {"Authorization": f"Bearer {token}"} if token else {}
