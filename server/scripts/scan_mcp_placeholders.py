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

"""Find catalogue hints that are being sent to servers as real credentials.

Third-party catalogues document a value with a sentence in double braces:

    {"EXA_API_KEY": "{{go get one at exa.ai}}"}

Copied into an install row or into ``~/.eigent/mcp.json`` that sentence stops
being documentation and becomes the credential. The request goes out, the server
answers 401, and nothing in the UI says why. The loader no longer produces these
values and both write paths refuse them now, but rows written before that are
still live -- this finds them.

Read-only by default. ``--fix`` blanks the value and keeps the key, which turns
a silent 401 into a visible empty field in the install form.

    python server/scripts/scan_mcp_placeholders.py
    python server/scripts/scan_mcp_placeholders.py --mcp-json ~/.eigent/mcp.json
    python server/scripts/scan_mcp_placeholders.py --fix
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

HINT = re.compile(r"\{\{|\}\}|\$\{[A-Za-z0-9_]+\}")
DEFAULT_MCP_JSON = Path.home() / ".eigent" / "mcp.json"


def database_url(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    url = os.environ.get("database_url")
    if url:
        return url
    env_file = Path(__file__).resolve().parents[1] / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("database_url="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("database_url not configured (env, server/.env or --database-url)")


def as_object(value):
    """Columns are JSON, but a hand-migrated deployment may hold text."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def scrub(mapping: dict) -> tuple[dict, list[str]]:
    """Blank every hinted value, keeping its key. Returns (obj, touched keys)."""
    out = dict(mapping)
    touched = []
    for key, value in mapping.items():
        if isinstance(value, str) and HINT.search(value):
            out[key] = ""
            touched.append(str(key))
    return out, touched


def scan_mapping(where: str, mapping, findings: list) -> tuple[dict | None, bool]:
    obj = as_object(mapping)
    if obj is None:
        return None, False
    fixed, touched = scrub(obj)
    for key in touched:
        findings.append((where, key, obj[key]))
    return fixed, bool(touched)


def scan_database(url: str, fix: bool) -> int:
    try:
        import psycopg2
        from psycopg2.extras import Json
    except ImportError:
        raise SystemExit(
            "psycopg2 is required: uv run --project server python "
            "server/scripts/scan_mcp_placeholders.py"
        )

    findings: list[tuple[str, str, str]] = []
    updates: list[tuple[str, int, dict]] = []
    connection = psycopg2.connect(url)
    connection.autocommit = False
    try:
        with connection.cursor() as cursor:
            cursor.execute("select id, key, install_command from mcp")
            for row_id, key, install_command in cursor.fetchall():
                command = as_object(install_command)
                if command is None:
                    continue
                changed = dict(command)
                dirty = False
                for field in ("env", "headers"):
                    fixed, touched = scan_mapping(
                        f"mcp#{row_id}({key}) install_command.{field}",
                        command.get(field),
                        findings,
                    )
                    if fixed is not None and touched:
                        changed[field] = fixed
                        dirty = True
                if dirty:
                    updates.append(("mcp", row_id, changed))

            cursor.execute("select id, mcp_key, env, headers from mcp_user")
            for row_id, key, env, headers in cursor.fetchall():
                changed_user: dict[str, dict] = {}
                for column, value in (("env", env), ("headers", headers)):
                    fixed, touched = scan_mapping(
                        f"mcp_user#{row_id}({key}) {column}", value, findings
                    )
                    if fixed is not None and touched:
                        changed_user[column] = fixed
                if changed_user:
                    updates.append(("mcp_user", row_id, changed_user))

            if fix:
                for table, row_id, payload in updates:
                    sets = ", ".join(f"{column} = %s" for column in payload)
                    cursor.execute(
                        f"update {table} set {sets} where id = %s",
                        [Json(value) for value in payload.values()] + [row_id],
                    )
        if fix:
            connection.commit()
        else:
            connection.rollback()
    finally:
        connection.close()

    report(findings, updates, fix, "database")
    return len(findings)


def scan_runtime_config(path: Path, fix: bool) -> int:
    if not path.is_file():
        print(f"runtime config: {path} not found, skipped")
        return 0
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        print(f"runtime config: {path} unreadable ({error}), skipped")
        return 0

    servers = payload.get("mcpServers")
    if not isinstance(servers, dict):
        print(f"runtime config: {path} has no mcpServers object, skipped")
        return 0

    findings: list[tuple[str, str, str]] = []
    changed_servers: dict[str, dict] = {}
    for name, server in servers.items():
        if not isinstance(server, dict):
            continue
        changed = dict(server)
        dirty = False
        for field in ("env", "headers"):
            fixed, touched = scan_mapping(
                f"{path}:{name} {field}", server.get(field), findings
            )
            if fixed is not None and touched:
                changed[field] = fixed
                dirty = True
        if dirty:
            changed_servers[name] = changed

    if fix and changed_servers:
        backup = path.with_suffix(path.suffix + ".bak")
        shutil.copy2(path, backup)
        for name, server in changed_servers.items():
            servers[name] = server
        path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"runtime config: rewrote {path} (backup: {backup})")

    report(findings, [("mcp.json", k, v) for k, v in changed_servers.items()], fix, "runtime config")
    return len(findings)


def report(findings, updates, fix: bool, scope: str) -> None:
    if not findings:
        print(f"{scope}: clean, no catalogue hints")
        return
    state = "blanked" if fix else "live"
    print(f"{scope}: {len(findings)} hinted value(s) {state}")
    for where, key, value in findings:
        print(f"  {where}.{key} = {value!r}")
    if not fix:
        print(
            f"{scope}: re-run with --fix to blank these values "
            f"({len(updates)} record(s) would change)"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="override database_url from env")
    parser.add_argument(
        "--mcp-json",
        type=Path,
        default=DEFAULT_MCP_JSON,
        help=f"runtime config written by Brain (default: {DEFAULT_MCP_JSON})",
    )
    parser.add_argument(
        "--skip-database",
        action="store_true",
        help="scan the runtime config only (no database connection)",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="blank hinted values, keeping every key; writes a .bak next to mcp.json",
    )
    args = parser.parse_args(argv)

    total = 0
    if not args.skip_database:
        total += scan_database(database_url(args.database_url), args.fix)
    total += scan_runtime_config(args.mcp_json.expanduser(), args.fix)

    if total and not args.fix:
        print("\nfound live catalogue hints; every one of them is a request that cannot authenticate")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
