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

"""The install row keeps a remote server's headers, and keeps them honest.

This is the store half of the chain. It ends at ``mcp_user.headers`` -- the
object the UI reads to decide which fields to ask for. The runtime half (that
the header is actually sent and answered with 200) is proven in
``backend/tests/app/service/test_mcp_config_headers.py``, because Brain is the
process that writes ``~/.eigent/mcp.json``.

The seam between the two is the shape below:

    {"url": "https://...", "headers": {"x-api-key": ""}}

Empty values, keys intact. Rooting out the empty value is not this layer's job
-- asking the user is.
"""

from __future__ import annotations

import os

os.environ.setdefault("database_url", "sqlite:///test.db")
os.environ.setdefault("secret_key", "test-secret")
os.environ.setdefault("redis_url", "redis://localhost:6379/0")
os.environ.setdefault("celery_broker_url", "redis://localhost:6379/0")
os.environ.setdefault("celery_result_url", "redis://localhost:6379/0")

import pytest

from app.domains.mcp.service.mcp_user_service import McpUserService
from app.model.mcp.mcp import Mcp, McpType
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
    monkeypatch.setattr(McpUser, "save", lambda self: None)


def _install(payload, mcp_type: McpType = McpType.Remote):
    mcp = Mcp(
        id=11,
        category_id=1,
        name="guarded",
        key="guarded",
        description="guarded remote",
        type=mcp_type,
        install_command=payload,
    )
    return McpUserService.install(11, 1, _FakeSession(mcp))


def test_the_catalog_placeholder_never_reaches_the_row() -> None:
    result = _install(
        {
            "type": "streamable_http",
            "url": "https://mcp.example.com/mcp",
            "headers": {"x-api-key": "{{get one at example.com}}"},
        }
    )

    assert result["success"] is True
    # The key survives so the form can ask for it; the hint does not survive,
    # because on the wire it would be sent as the key.
    assert result["mcp_user"].headers == {"x-api-key": ""}


def test_a_real_header_value_is_kept() -> None:
    result = _install(
        {"url": "https://mcp.example.com/mcp", "headers": {"x-api-key": "abc123"}}
    )

    assert result["success"] is True
    assert result["mcp_user"].headers == {"x-api-key": "abc123"}


def test_headers_on_a_local_command_are_refused() -> None:
    # Storing them next to a command would build a config that silently ignores
    # them, which is the mcp_env mistake with a different column.
    result = _install(
        {
            "command": "npx",
            "args": ["-y", "pkg@1.0.0"],
            "headers": {"x-api-key": "abc"},
        }
    )

    assert result["success"] is False
    assert result["error_code"] == "MCP_HEADERS_WITHOUT_URL"


def test_a_header_object_that_is_not_an_object_is_refused() -> None:
    result = _install({"url": "https://mcp.example.com/mcp", "headers": "x-api-key"})

    assert result["success"] is False
    assert result["error_code"] == "MCP_INVALID_HEADERS"


def test_a_non_string_value_is_coerced_not_dropped() -> None:
    # JSON allows numbers; httpx does not. Coercing keeps the header rather than
    # turning a typo into a silently missing credential.
    result = _install(
        {"url": "https://mcp.example.com/mcp", "headers": {"x-tenant": 42}}
    )

    assert result["success"] is True
    assert result["mcp_user"].headers == {"x-tenant": "42"}


def test_the_env_side_gets_the_same_treatment() -> None:
    result = _install(
        {
            "command": "uvx",
            "args": ["mcp-server-exa"],
            "env": {"EXA_API_KEY": "{{go get one at exa.ai}}", "REGION": "eu"},
        },
        McpType.Local,
    )

    assert result["success"] is True
    assert result["mcp_user"].env == {"EXA_API_KEY": "", "REGION": "eu"}


def test_a_local_server_still_installs_without_headers() -> None:
    result = _install({"command": "uvx", "args": ["mcp-server-fetch"]}, McpType.Local)

    assert result["success"] is True
    assert result["mcp_user"].headers is None
    assert result["mcp_user"].server_url is None
