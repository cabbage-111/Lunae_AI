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
# limitations under the License. ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========
"""Finding catalogue hints that are already live.

Rows written before the loader stopped emitting ``{{...}}`` are still in the
database and in ``~/.eigent/mcp.json``. Those users are sending a Chinese
sentence as an API key and seeing a 401. This checks the finder finds them and
the fixer blanks the value without touching the key.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.scan_mcp_placeholders import HINT, main, scan_runtime_config, scrub


def test_scrub_keeps_the_key_and_blanks_the_hint() -> None:
    cleaned, touched = scrub(
        {"EXA_API_KEY": "{{go get one at exa.ai}}", "REGION": "eu-west-1"}
    )

    assert touched == ["EXA_API_KEY"]
    assert cleaned == {"EXA_API_KEY": "", "REGION": "eu-west-1"}


def test_a_real_value_is_not_touched() -> None:
    cleaned, touched = scrub({"x-api-key": "sk-live-123"})

    assert touched == []
    assert cleaned == {"x-api-key": "sk-live-123"}


def test_the_hint_pattern_matches_what_the_catalogues_actually_ship() -> None:
    # These are the shapes in the 536-entry catalogue.
    for value in ("{{去 exa.ai 申请}}", "{{ get one }}", "{{key}}"):
        assert HINT.search(value)


@pytest.fixture
def runtime_config(tmp_path: Path) -> Path:
    path = tmp_path / "mcp.json"
    path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "exa": {
                        "command": "uvx",
                        "args": ["mcp-server-exa"],
                        "env": {"EXA_API_KEY": "{{去 exa.ai 申请}}"},
                    },
                    "guarded": {
                        "url": "https://mcp.example.com/mcp",
                        "headers": {"x-api-key": "{{where}}"},
                    },
                    "clean": {"command": "npx", "args": ["-y", "pkg"]},
                }
            }
        ),
        encoding="utf-8",
    )
    return path


def test_it_finds_hints_in_both_env_and_headers(runtime_config: Path, capsys) -> None:
    found = scan_runtime_config(runtime_config, fix=False)

    output = capsys.readouterr().out
    assert found == 2
    assert "env.EXA_API_KEY" in output
    assert "headers.x-api-key" in output
    assert "--fix" in output


def test_fix_blanks_values_and_leaves_a_backup(runtime_config: Path) -> None:
    scan_runtime_config(runtime_config, fix=True)

    payload = json.loads(runtime_config.read_text(encoding="utf-8"))
    servers = payload["mcpServers"]
    assert servers["exa"]["env"] == {"EXA_API_KEY": ""}
    assert servers["guarded"]["headers"] == {"x-api-key": ""}
    assert servers["clean"] == {"command": "npx", "args": ["-y", "pkg"]}
    assert runtime_config.with_suffix(".json.bak").is_file()


def test_a_clean_config_is_reported_as_clean(tmp_path: Path, capsys) -> None:
    path = tmp_path / "mcp.json"
    path.write_text(
        json.dumps({"mcpServers": {"ok": {"url": "https://x.test/mcp"}}}),
        encoding="utf-8",
    )

    assert scan_runtime_config(path, fix=False) == 0
    assert "clean" in capsys.readouterr().out


def test_main_exits_non_zero_when_hints_are_live(runtime_config: Path) -> None:
    code = main(["--skip-database", "--mcp-json", str(runtime_config)])

    assert code == 1


def test_main_returns_zero_after_the_fix(runtime_config: Path) -> None:
    assert main(["--skip-database", "--mcp-json", str(runtime_config), "--fix"]) == 0
    assert main(["--skip-database", "--mcp-json", str(runtime_config)]) == 0
