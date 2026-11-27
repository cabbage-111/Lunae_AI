from __future__ import annotations

import os

os.environ.setdefault("database_url", "sqlite:///test.db")
os.environ.setdefault("secret_key", "test-secret")
os.environ.setdefault("redis_url", "redis://localhost:6379/0")
os.environ.setdefault("celery_broker_url", "redis://localhost:6379/0")
os.environ.setdefault("celery_result_url", "redis://localhost:6379/0")

import pytest

from app.domains.mcp.service.mcp_user_service import McpUserService
from app.model.mcp.mcp import Mcp, McpOut, McpType
from app.model.mcp.mcp_user import McpUser


class _EmptyResult:
    def first(self):
        return None


class _FakeSession:
    """Minimal Session stand-in: no row is installed yet for this user."""

    def __init__(self, mcp: Mcp) -> None:
        self.mcp = mcp

    def get(self, model, pk):  # noqa: ANN001
        return self.mcp

    def exec(self, statement):  # noqa: ANN001
        return _EmptyResult()


@pytest.fixture(autouse=True)
def _no_persist(monkeypatch: pytest.MonkeyPatch) -> None:
    # install() persists through McpUser.save(); the branch behaviour under test
    # is the payload mapping, so keep the unit test DB-free.
    monkeypatch.setattr(McpUser, "save", lambda self: None)


def _install(payload, mcp_type: McpType = McpType.Remote):
    mcp = Mcp(
        id=7,
        category_id=1,
        name="demo",
        key="demo",
        description="demo",
        type=mcp_type,
        install_command=payload,
    )
    return McpUserService.install(7, 1, _FakeSession(mcp))


def test_remote_catalog_entry_installs_with_server_url() -> None:
    result = _install({"url": " https://mcp.deepwiki.com/mcp "})

    assert result["success"] is True
    mcp_user = result["mcp_user"]
    assert mcp_user.type == McpType.Remote
    assert mcp_user.server_url == "https://mcp.deepwiki.com/mcp"
    assert mcp_user.command is None
    assert mcp_user.args is None


def test_local_catalog_entry_serializes_args() -> None:
    result = _install(
        {"command": "uvx", "args": ["mcp-server-fetch"], "env": {"A": "1"}},
        McpType.Local,
    )

    assert result["success"] is True
    mcp_user = result["mcp_user"]
    assert mcp_user.type == McpType.Local
    assert mcp_user.command == "uvx"
    assert mcp_user.args == '["mcp-server-fetch"]'
    assert mcp_user.env == {"A": "1"}
    assert mcp_user.server_url is None


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"type": "streamable_http"},
        "{not json",
    ],
)
def test_payload_without_command_or_url_is_rejected(payload) -> None:
    result = _install(payload)

    assert result == {"success": False, "error_code": "MCP_INVALID_INSTALL_COMMAND"}


def test_market_output_normalizes_hyphenated_transport() -> None:
    # Catalogs ship "streamable-http"; the MCP client only accepts
    # "streamable_http", so the API must not leak the hyphenated spelling.
    out = McpOut(
        id=1,
        category_id=1,
        name="demo",
        key="demo",
        description="demo",
        home_page="",
        type=McpType.Remote,
        status=1,
        install_command={"url": "https://example.com/mcp", "type": "streamable-http"},
    )

    assert out.install_command["type"] == "streamable_http"
