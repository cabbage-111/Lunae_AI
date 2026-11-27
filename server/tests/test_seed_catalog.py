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
"""The catalogue -> mcp row bridge in seed_mcp_market.py.

The loader validates manifests; this script validates *the file the loader
wrote*, because a catalogue is a file on disk that may be stale or hand-edited.
"""

from __future__ import annotations

import json

import pytest

from scripts.seed_mcp_market import (
    CATALOG_FIELDS,
    TYPE_LOCAL,
    TYPE_REMOTE,
    CatalogSchemaMismatch,
    load_catalog,
    main,
    normalize_catalog_record,
    records_from_payload,
)


def _remote(**overrides) -> dict:
    record = {
        "category": None,
        "name": "weather",
        "key": "weather",
        "description": "Current conditions and forecast for a city.",
        "home_page": "https://example.io",
        "type": TYPE_REMOTE,
        "status": 1,
        "sort": 10,
        "server_name": "weather",
        "install_command": {"type": "streamable_http", "url": "https://mcp.example.io/mcp"},
    }
    record.update(overrides)
    return record


def test_transport_type_is_made_runnable() -> None:
    # A hand-written catalogue is still allowed to say "streamable-http".
    row = normalize_catalog_record(
        _remote(install_command={"type": "streamable-http", "url": "https://x.test/mcp"}),
        1,
    )

    assert row["install_command"]["type"] == "streamable_http"
    assert row["type"] == TYPE_REMOTE


def test_type_is_derived_from_the_payload_not_from_the_file() -> None:
    row = normalize_catalog_record(
        _remote(type=TYPE_REMOTE, install_command={"command": "uvx", "args": ["pkg"]}),
        1,
    )

    assert row["type"] == TYPE_LOCAL


def test_an_undeclared_category_is_classified_once_here() -> None:
    row = normalize_catalog_record(_remote(category=None), 1)

    assert row["category"] == "其他"


def test_a_declared_category_is_kept_verbatim() -> None:
    row = normalize_catalog_record(_remote(category="开发工具"), 1)

    assert row["category"] == "开发工具"


@pytest.mark.parametrize(
    "broken",
    [
        {"key": ""},
        {"install_command": {}},
        {"install_command": "not-an-object"},
        {"install_command": {"type": "streamable_http"}},
    ],
)
def test_a_row_that_cannot_connect_is_rejected(broken) -> None:
    with pytest.raises(ValueError):
        normalize_catalog_record(_remote(**broken), 1)


def test_a_duplicate_key_is_dropped_not_overwritten(capsys) -> None:
    records = records_from_payload(
        {"records": [_remote(), _remote(name="weather two")]}, "test"
    )

    assert len(records) == 1
    assert "duplicate key" in capsys.readouterr().out


def test_rejected_entries_from_the_loader_are_reported(capsys) -> None:
    records = records_from_payload(
        {
            "records": [_remote()],
            "rejected": [{"name": "com.acme/notes", "reason": "UNRUNNABLE", "detail": "needs tenant"}],
        },
        "test",
    )

    assert len(records) == 1
    assert "com.acme/notes UNRUNNABLE" in capsys.readouterr().out


def test_load_catalog_reads_the_envelope_the_cli_writes(tmp_path) -> None:
    path = tmp_path / "rows.json"
    path.write_text(
        json.dumps({"generator": "mcp-market", "count": 1, "records": [_remote()]}),
        encoding="utf-8",
    )

    records = load_catalog(path)

    assert [record["key"] for record in records] == ["weather"]


def test_load_catalog_accepts_a_bare_list(tmp_path) -> None:
    path = tmp_path / "rows.json"
    path.write_text(json.dumps([_remote()]), encoding="utf-8")

    assert len(load_catalog(path)) == 1


def test_an_unknown_field_aborts_instead_of_being_dropped() -> None:
    # A whitelist that drops quietly is how a field disappears between "the
    # loader produced a row" and "the database stored a row".
    with pytest.raises(CatalogSchemaMismatch) as failure:
        normalize_catalog_record(_remote(tools=["get_forecast"]), 1)

    assert "tools" in str(failure.value)


def test_provenance_is_known_by_name_and_never_inserted() -> None:
    row = normalize_catalog_record(
        _remote(version="1.2.0", pending_env=["x-api-key"], manifest="io.example/weather"),
        1,
    )

    assert row["key"] == "weather"
    for field in ("version", "pending_env", "manifest"):
        assert field not in row


def test_the_row_is_exactly_the_inserted_columns() -> None:
    row = normalize_catalog_record(_remote(), 1)

    assert set(row) == set(CATALOG_FIELDS)


def test_a_mismatch_is_not_swallowed_as_a_bad_row() -> None:
    with pytest.raises(CatalogSchemaMismatch):
        records_from_payload({"records": [_remote(tools=[])]}, "test")


def test_main_refuses_to_seed_a_mismatched_file(tmp_path) -> None:
    path = tmp_path / "rows.json"
    path.write_text(json.dumps({"records": [_remote(tools=[])]}), encoding="utf-8")

    with pytest.raises(SystemExit) as exit_code:
        main(["--catalog", str(path)])

    assert "refusing to seed" in str(exit_code.value.code)


def test_a_bad_record_stops_the_batch_before_any_row_is_built() -> None:
    # The contract check must not depend on which exception base class the
    # per-row handler happens to catch. It runs before the loop, so a payload
    # whose first record is fine and second is not still aborts entirely.
    payload = {"records": [_remote(), _remote(key="other", tools=["get"])]}

    with pytest.raises(CatalogSchemaMismatch) as failure:
        records_from_payload(payload, "test")

    assert "tools" in str(failure.value)


def test_the_batch_check_precedes_skipping(capsys, monkeypatch) -> None:
    # A per-row failure prints "skipped ...". The batch check must fire before
    # anything is written to stdout, otherwise a partial run looks successful.
    monkeypatch.setattr(
        "scripts.seed_mcp_market.normalize_catalog_record",
        lambda raw, index: (_ for _ in ()).throw(ValueError("bad row")),
    )

    with pytest.raises(CatalogSchemaMismatch):
        records_from_payload({"records": [_remote(tools=[])]}, "test")

    assert capsys.readouterr().out == ""


def test_scan_paths_are_named() -> None:
    # The batch check reports which file disagreed; a bare code sends the
    # reader back to grep for it.
    with pytest.raises(CatalogSchemaMismatch) as failure:
        records_from_payload({"records": [_remote(tools=[])]}, "rows.json")

    assert "rows.json" in str(failure.value)
