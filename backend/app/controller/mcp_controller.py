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

import logging

from fastapi import APIRouter, Depends, HTTPException

from app.auth import require_local_control_if_configured
from app.service import mcp_oauth
from app.service.mcp_config import (
    McpConfigError,
    add_mcp,
    read_mcp_config,
    remove_mcp,
    update_mcp,
)

router = APIRouter(dependencies=[Depends(require_local_control_if_configured)])
mcp_logger = logging.getLogger("mcp_controller")


@router.get("/mcp/list")
def mcp_list() -> dict:
    """List all MCP servers (global config)."""
    return read_mcp_config()


@router.post("/mcp/install")
def mcp_install(body: dict) -> dict:
    """Install/add MCP server to global config. Body: { name, mcp }."""
    name = body.get("name")
    mcp = body.get("mcp")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if not mcp or not isinstance(mcp, dict):
        raise HTTPException(status_code=400, detail="mcp object is required")
    try:
        add_mcp(str(name).strip(), mcp)
    except McpConfigError as error:
        raise HTTPException(status_code=400, detail=str(error))
    mcp_logger.info("MCP installed: %s", name)
    return {"success": True}


def _open_authorize_page(url: str) -> bool:
    """Ask the OS to open the authorization page in the default browser.

    The renderer cannot do this reliably. `window.open` runs after an `await`
    (the URL comes from this service), so it is no longer a user gesture and
    popup rules drop it; the desktop bridge reports a refusal as
    `{success: false}` instead of raising, so the dialog used to say "the
    browser is open" while nothing had opened. Brain runs on the same machine
    as the browser, so it can hand the URL to the OS itself.

    Returns False when the platform gives us no browser to open, which is the
    renderer's cue to offer the link instead of pretending it worked.
    """
    try:
        import webbrowser

        opened = webbrowser.open(url, new=2, autoraise=True)
        mcp_logger.info("MCP authorize page handed to system browser: %s", opened)
        return bool(opened)
    except Exception as error:  # noqa: BLE001 - never fail authorization over this
        mcp_logger.warning("MCP authorize page could not be opened: %s", error)
        return False


@router.post("/mcp/oauth/start")
def mcp_oauth_start(body: dict) -> dict:
    """Start the browser authorization a remote server asked for.

    Body: ``{ name, mcp: { url, ... } }``. Returns the URL to open; the callback
    listener and the token exchange happen here, and the config is written on
    success. The token never crosses the renderer: it is the process that owns
    ``mcp.json`` that obtains and stores it.

    This is what a 401 with ``WWW-Authenticate: Bearer resource_metadata=...``
    means. Header plumbing cannot satisfy those servers -- no static value makes
    them answer 200.
    """
    name = str(body.get("name") or "").strip()
    mcp = body.get("mcp")
    if not name or not isinstance(mcp, dict):
        raise HTTPException(
            status_code=400, detail="name and mcp object are required"
        )
    url = str(mcp.get("url") or "").strip()
    if not url:
        raise HTTPException(
            status_code=400, detail="mcp.url is required to authorize"
        )

    def apply_token(token: str) -> None:
        headers = dict(mcp.get("headers") or {})
        headers["Authorization"] = f"Bearer {token}"
        try:
            # update_mcp creates the entry when it is absent, which is the
            # normal order here: authorize first, register the row afterwards.
            update_mcp(name, {**mcp, "headers": headers})
        except (
            McpConfigError
        ) as error:  # the config rejects what it cannot run
            mcp_logger.error(
                "MCP authorization stored but config rejected: %s", error
            )

    try:
        started = mcp_oauth.start(url, on_authorized=apply_token)
    except mcp_oauth.McpOAuthError as error:
        raise HTTPException(status_code=400, detail=str(error))
    mcp_logger.info(
        "MCP authorization started: %s (%s)", name, started["state"]
    )
    return {
        **started,
        "name": name,
        # Opened here rather than in the renderer: this process owns the
        # desktop session, so the login page appears even when the client is a
        # plain browser tab or a sandboxed webview.
        "browser_opened": _open_authorize_page(started["authorize_url"]),
    }


@router.get("/mcp/oauth/status/{state}")
def mcp_oauth_status(state: str) -> dict:
    """Poll an authorization: pending | authorized | error | unknown."""
    return mcp_oauth.status(state)


@router.post("/mcp/oauth/probe")
def mcp_oauth_probe(body: dict) -> dict:
    """Ask a remote server whether it wants authorization, before installing.

    The renderer needs this answer to decide what the button does: install
    quietly, or ask the user to authorize. Guessing from the URL would be a
    guess; the 401 is the answer.
    """
    url = str(body.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required to probe")
    found = mcp_oauth.probe(url)
    mcp_logger.info("MCP probe %s -> %s", url, found["outcome"])
    return found


@router.delete("/mcp/{name}")
def mcp_remove(name: str) -> dict:
    """Remove MCP server from global config."""
    remove_mcp(name)
    mcp_logger.info("MCP removed: %s", name)
    return {"success": True}


@router.put("/mcp/{name}")
def mcp_update(name: str, mcp: dict) -> dict:
    """Update MCP server in global config. Body is the mcp config object."""
    try:
        update_mcp(name, mcp)
    except McpConfigError as error:
        raise HTTPException(status_code=400, detail=str(error))
    mcp_logger.info("MCP updated: %s", name)
    return {"success": True}
