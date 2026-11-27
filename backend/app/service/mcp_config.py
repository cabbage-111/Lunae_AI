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

import json
import logging
import re
from pathlib import Path

logger = logging.getLogger("mcp_config")

MCP_CONFIG_DIR = Path.home() / ".eigent"
MCP_CONFIG_PATH = MCP_CONFIG_DIR / "mcp.json"

# A value like "{{get one at exa.ai}}" is catalogue documentation. It is harmless
# in a form and catastrophic on the wire: the sentence is sent as the credential,
# the server answers 401, and nothing in the UI explains why. This is the last
# gate before the request, so it refuses the write instead of forwarding it.
#
# Keep in step with app/core/mcp_auth.py in the server package (the canonical
# definition) and src/lib/mcpAuth.ts in the renderer. This module cannot import
# the server's copy -- separate process, separate package -- so the spellings are
# duplicated by necessity and pinned by
# test/fixtures/mcp-auth-cases.json, which all three read.
HINT_PLACEHOLDER = re.compile(r"\{\{|\}\}|\$\{[A-Za-z0-9_]+\}")


class McpConfigError(ValueError):
    """The config would be written but cannot possibly connect."""


def _reject_hint(field: str, name: str, value) -> None:
    if isinstance(value, str) and HINT_PLACEHOLDER.search(value):
        raise McpConfigError(
            f"{field}.{name} still contains a catalogue hint: {value!r}. "
            "Ask the user for the real value instead of installing it."
        )


def _check_env(server: dict) -> None:
    env = server.get("env")
    if env is None:
        return
    if not isinstance(env, dict):
        raise McpConfigError("env must be an object of key/value pairs")
    for name, value in env.items():
        _reject_hint("env", str(name), value)


def _check_headers(server: dict) -> None:
    """Refuse a remote install that cannot authenticate.

    An empty header value is not "unset": it is a header sent empty, which the
    server rejects. Better to fail here, where the message can name the header,
    than to let it surface as an opaque 401 minutes later.
    """
    headers = server.get("headers")
    if headers is None:
        return
    if not isinstance(headers, dict):
        raise McpConfigError("headers must be an object of key/value pairs")
    for name, value in headers.items():
        if not isinstance(name, str) or not name.strip():
            raise McpConfigError("headers cannot contain an empty name")
        _reject_hint("headers", name, value)
        if not isinstance(value, str) or not value.strip():
            raise McpConfigError(
                f"headers.{name} has no value. Collect it from the user, "
                "then install: an empty header authenticates nothing."
            )


def _check(server: dict) -> None:
    if "url" in server and "command" in server:
        raise McpConfigError(
            "a server declares either a command or a url, not both"
        )
    if "headers" in server and "url" not in server:
        raise McpConfigError(
            "headers require a url transport; local servers use env"
        )
    _check_env(server)
    _check_headers(server)


def _normalize_args(args) -> list[str]:
    """Normalize args to list of strings."""
    if args is None:
        return []
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
            return (
                [str(x) for x in parsed]
                if isinstance(parsed, list)
                else [args]
            )
        except json.JSONDecodeError:
            return [x.strip() for x in args.split(",") if x.strip()]
    if isinstance(args, list):
        return [str(x) for x in args]
    return []


def _normalize_mcp(mcp: dict) -> dict:
    """Normalize MCP server config."""
    out = dict(mcp)
    if "args" in out:
        out["args"] = _normalize_args(out["args"])
    return out


def get_mcp_config_path() -> Path:
    return MCP_CONFIG_PATH


def read_mcp_config() -> dict:
    """Read MCP config from ~/.eigent/mcp.json."""
    if not MCP_CONFIG_PATH.exists():
        default = {"mcpServers": {}}
        write_mcp_config(default)
        return default
    try:
        data = MCP_CONFIG_PATH.read_text(encoding="utf-8")
        parsed = json.loads(data)
        if not isinstance(parsed.get("mcpServers"), dict):
            return {"mcpServers": {}}
        for name, server in parsed["mcpServers"].items():
            if isinstance(server, dict):
                parsed["mcpServers"][name] = _normalize_mcp(server)
        return _with_fresh_tokens(parsed)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read MCP config: %s, using default", e)
        return {"mcpServers": {}}


def _with_fresh_tokens(config: dict) -> dict:
    """Renew expired bearers before a client can see them.

    The file holds the token as it was when the user authorized. Once it
    expires, the server answers 401 and nothing in the request says why; a
    refresh here keeps "authorize once" true without the user noticing.
    """
    try:
        from app.service import mcp_oauth

        return mcp_oauth.apply_tokens(config)
    except Exception as error:  # noqa: BLE001 - a broken store must not block listing
        logger.warning("MCP token refresh skipped: %s", error)
        return config


def write_mcp_config(config: dict) -> None:
    """Write MCP config to ~/.eigent/mcp.json."""
    MCP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    MCP_CONFIG_PATH.write_text(
        json.dumps(config, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def add_mcp(name: str, mcp: dict) -> None:
    """Add MCP server to config."""
    _check(mcp)
    config = read_mcp_config()
    if name not in config["mcpServers"]:
        config["mcpServers"][name] = _normalize_mcp(mcp)
        write_mcp_config(config)


def remove_mcp(name: str) -> None:
    """Remove MCP server from config."""
    config = read_mcp_config()
    if name in config["mcpServers"]:
        del config["mcpServers"][name]
        write_mcp_config(config)


def update_mcp(name: str, mcp: dict) -> None:
    """Update MCP server in config."""
    _check(mcp)
    config = read_mcp_config()
    config["mcpServers"][name] = _normalize_mcp(mcp)
    write_mcp_config(config)
