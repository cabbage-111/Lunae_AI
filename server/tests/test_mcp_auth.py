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

"""One case table, three implementations.

`carry_auth` runs in three processes that cannot share a module: the store
(server/), Brain (backend/) and the renderer (src/). Every copy is pinned to
test/fixtures/mcp-auth-cases.json, so the definition cannot drift quietly.
Before this, the renderer's copy knew about `{{...}}` but not `${VAR}`, and a
catalogue row spelled `${ACME_KEY}` skipped the "ask for it" dialog entirely.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.mcp_auth import McpAuthError, carry_auth, is_hint

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/mcp-auth-cases.json").read_text(
        encoding="utf-8"
    )
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_carry_auth_matches_the_shared_table(case):
    value, warnings = carry_auth(case["input"], field=case["field"])
    assert value == case["value"]
    assert [w["code"] for w in warnings] == case["warnings"]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_hint_agrees_with_the_blanking_decision(case):
    """Anything carry_auth blanks must be reported as a hint by is_hint.

    The reverse is not required: a hint in a value position can also be a whole
    non-object, and carry_auth never sees that.
    """
    value, warnings = carry_auth(case["input"], field=case["field"])
    source = case["input"] or {}
    for key, original in source.items():
        if value and value.get(key.strip()) == "" and original != "":
            assert is_hint(original), f"{case['id']}: {key} blanked but not a hint"


def test_non_object_is_refused_not_coerced():
    """A list cannot be a header map; silently making one up hides the bug."""
    with pytest.raises(McpAuthError) as raised:
        carry_auth([{"name": "x-api-key"}])
    assert raised.value.code == "MCP_INVALID_HEADERS"


def test_the_dollar_spelling_is_a_hint():
    """The case that proves the old three-copy divergence is gone."""
    assert is_hint("${ACME_KEY}")
    assert is_hint("{{get one at exa.ai}}")
    assert not is_hint("sk-live-123")
    assert not is_hint("Bearer sk-live-123")
