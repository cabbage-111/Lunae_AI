#!/usr/bin/env python3
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

"""Seed the MCP market (``category`` + ``mcp`` tables).

The self-hosted server ships schema only: ``mcp``/``category`` stay empty until
someone fills them, so ``GET /api/v1/mcps`` returns an empty page and every
market surface renders blank. This script fills them from one of four places:

    --starter             3 curated rows, checked into this file (the default)
    --catalog FILE        rows produced by ``mcp-market/src/cli.js catalog``
    --from-loader         runs that CLI and reads its output directly
    --source DIR          a WorkBuddy-style connector marketplace directory

Nothing third-party is bundled: a fresh checkout seeds the starter set, and
anything larger has to name the source it came from.

Dry run by default -- nothing is written unless ``--apply`` is passed.

    python server/scripts/seed_mcp_market.py                  # preview starter
    python server/scripts/seed_mcp_market.py --apply          # write starter
    python server/scripts/seed_mcp_market.py --from-loader --apply
    python server/scripts/seed_mcp_market.py --catalog rows.json --apply
    python server/scripts/seed_mcp_market.py --source DIR     # offline import
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOADER = PROJECT_ROOT / "mcp-market" / "src" / "cli.js"
LOCAL_SOURCES = PROJECT_ROOT / "mcp-market" / "sources.local.json"

# McpType in app/model/mcp/mcp.py
TYPE_LOCAL = 1
TYPE_REMOTE = 2
STATUS_ONLINE = 1

CATEGORY_RULES: list[tuple[str, tuple[str, ...]]] = [
    (
        "金融投资",
        (
            "股票",
            "行情",
            "财报",
            "基金",
            "证券",
            "期货",
            "银行",
            "保险",
            "投资",
            "stock",
            "finance",
            "trading",
            "equity",
        ),
    ),
    (
        "办公协作",
        (
            "文档",
            "表格",
            "笔记",
            "会议",
            "日历",
            "邮件",
            "协作",
            "审批",
            "汇报",
            "notion",
            "excel",
            "doc",
            "mail",
            "calendar",
            "slack",
            "lark",
            "notion",
        ),
    ),
    (
        "开发工具",
        (
            "代码",
            "仓库",
            "数据库",
            "部署",
            "开发",
            "测试",
            "接口",
            "git",
            "github",
            "gitlab",
            "code",
            "repo",
            "database",
            "devops",
            "api",
        ),
    ),
    (
        "搜索资讯",
        (
            "搜索",
            "新闻",
            "资讯",
            "舆情",
            "热点",
            "百科",
            "search",
            "news",
            "web",
            "browse",
        ),
    ),
    (
        "数据分析",
        (
            "分析",
            "报表",
            "可视化",
            "统计",
            "图表",
            "analytics",
            "chart",
            "bi",
            "report",
        ),
    ),
]
FALLBACK_CATEGORY = "其他"


def load_marketplace(source: Path) -> list[dict]:
    manifest_path = source / ".codebuddy-plugin" / "marketplace.json"
    if not manifest_path.is_file():
        raise SystemExit(f"marketplace.json not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    plugins = manifest.get("plugins") or []
    if not isinstance(plugins, list):
        raise SystemExit("marketplace.json: 'plugins' is not a list")
    return plugins


def plugin_dir(source: Path, entry: dict) -> Path:
    rel = str(entry.get("source") or "").strip()
    rel = rel[2:] if rel.startswith("./") else rel
    return source / rel


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def first_mcp_server(package: Path) -> tuple[str, dict] | None:
    servers = read_json(package / "mcp.json").get("mcpServers")
    if not isinstance(servers, dict):
        return None
    for server_name, config in servers.items():
        if isinstance(config, dict):
            return str(server_name), config
    return None


def display_of(package: Path) -> dict:
    plugin = read_json(package / ".codebuddy-plugin" / "plugin.json")
    extensions = plugin.get("extensions")
    if not isinstance(extensions, dict):
        return {}
    workbuddy = extensions.get("ai.workbuddy")
    if not isinstance(workbuddy, dict):
        return {}
    display = workbuddy.get("display")
    return display if isinstance(display, dict) else {}


def classify(name: str, description: str) -> str:
    haystack = f"{name} {description}".lower()
    for category, keywords in CATEGORY_RULES:
        if any(keyword in haystack for keyword in keywords):
            return category
    return FALLBACK_CATEGORY


# The MCP client (camel) only accepts these transport spellings.
RUNTIME_TRANSPORTS = {"streamable_http", "sse", "stdio", "websocket"}


def runtime_install_command(config: dict) -> dict:
    """Rewrite a catalog server config into something the runtime can connect.

    Catalogs are authored with ``"type": "streamable-http"`` while the client
    validates ``{"stdio","sse","streamable_http","websocket"}``; the hyphenated
    value raises ``Invalid type`` and the toolkit then fails silently with an
    empty tool list. Normalize here so stored rows are runnable as-is.
    """
    out = dict(config)
    transport = out.get("type")
    if isinstance(transport, str):
        normalized = transport.strip().lower().replace("-", "_")
        if normalized in RUNTIME_TRANSPORTS:
            out["type"] = normalized
        else:
            out.pop("type", None)
    return out


CATALOG_FIELDS = (
    "category",
    "name",
    "key",
    "description",
    "home_page",
    "type",
    "status",
    "sort",
    "server_name",
    "install_command",
)

# Emitted by the loader for traceability. Deliberately *not* columns: the file
# keeps them so nothing is lost between "produced" and "stored", but they never
# reach the table. See docs/DESIGN.md, "The bridge into the mcp table".
PROVENANCE_FIELDS = ("manifest", "version", "pending_env", "source")

KNOWN_FIELDS = frozenset(CATALOG_FIELDS) | frozenset(PROVENANCE_FIELDS)


class CatalogSchemaMismatch(RuntimeError):
    """The catalogue carries a field this script does not know about.

    Raised rather than dropped on purpose. A whitelist is a filter, and a filter
    that discards quietly is the worst kind of data loss: the loader reports it
    produced a complete row, the database reports the insert succeeded, the logs
    look healthy, and the only symptom is a missing form field three layers
    away. Fail where the disagreement is visible instead.
    """


def _text(value) -> str:
    return "" if value is None else str(value).strip()


def normalize_catalog_record(raw: dict, index: int) -> dict:
    """Coerce one loader record into an insertable row, or raise ValueError.

    The loader already validated the manifest, but a catalogue file is a file on
    disk and may be hand-edited or stale, so the shape is re-checked here. Type
    and server_name are derived rather than trusted: a row is remote exactly
    when it carries a URL, and it cannot be installed at all without one or the
    other.

    A field outside ``KNOWN_FIELDS`` is a contract break, not a bad row: it
    raises ``CatalogSchemaMismatch`` so the whole run stops.
    """
    if not isinstance(raw, dict):
        raise ValueError("record is not an object")

    unknown = sorted(set(raw) - KNOWN_FIELDS)
    if unknown:
        raise CatalogSchemaMismatch(
            f"unknown field(s) {unknown} in {raw.get('key') or '(no key)'}: "
            "the catalogue and this table disagree. Update KNOWN_FIELDS and "
            "docs/DESIGN.md, or regenerate the file with the matching loader."
        )

    key = _text(raw.get("key"))
    if not key:
        raise ValueError("missing key")

    command = raw.get("install_command")
    if not isinstance(command, dict):
        raise ValueError("install_command is not an object")
    command = runtime_install_command(command)

    url = _text(command.get("url"))
    binary = _text(command.get("command"))
    if not url and not binary:
        raise ValueError("install_command has neither command nor url")

    name = _text(raw.get("name")) or key
    description = _text(raw.get("description"))
    category = _text(raw.get("category")) or classify(name, description)
    try:
        sort = int(raw.get("sort"))
    except (TypeError, ValueError):
        sort = index * 10

    return {
        "category": category,
        "name": name[:200],
        "key": key[:128],
        "description": description,
        "home_page": _text(raw.get("home_page"))[:1024],
        "type": TYPE_REMOTE if url else TYPE_LOCAL,
        "status": STATUS_ONLINE,
        "sort": sort,
        "server_name": (_text(raw.get("server_name")) or key)[:128],
        "install_command": command,
    }


def assert_known_fields(entries, label: str) -> None:
    """Check the whole batch against the table before a single row is built.

    Deliberately outside the per-row ``try``. A row-shaped check that runs inside
    that loop survives only as long as nobody writes ``except Exception`` -- and
    the next person who wants resilient seeding will write exactly that. A
    contract check is not a row check: it is batch-level, so it runs first, and
    a mismatch stops the run no matter which base class the error has.
    """
    for index, raw in enumerate(entries, start=1):
        if not isinstance(raw, dict):
            continue
        unknown = sorted(set(raw) - KNOWN_FIELDS)
        if unknown:
            raise CatalogSchemaMismatch(
                f"unknown field(s) {unknown} in {raw.get('key') or f'#{index}'} "
                f"({label}): the catalogue and this table disagree. Update "
                "KNOWN_FIELDS and docs/DESIGN.md, or regenerate the file with "
                "the matching loader."
            )


def records_from_payload(payload, label: str) -> list[dict]:
    """Read a loader envelope (or a bare list) into rows, reporting what dropped."""
    if isinstance(payload, dict):
        entries = payload.get("records")
        reported = payload.get("rejected") or []
    else:
        entries = payload
        reported = []
    if not isinstance(entries, list):
        raise SystemExit(f"{label}: expected a 'records' array")

    # Before anything is normalised, printed or counted.
    assert_known_fields(entries, label)

    for item in reported:
        if isinstance(item, dict):
            print(
                f"skipped {item.get('name')} {item.get('reason')}: {item.get('detail')}"
            )

    records: list[dict] = []
    seen: set[str] = set()
    for index, raw in enumerate(entries, start=1):
        try:
            record = normalize_catalog_record(raw, index)
        except ValueError as error:
            print(f"skipped {label} #{index}: {error}")
            continue
        if record["key"] in seen:
            print(f"skipped {record['key']}: duplicate key")
            continue
        seen.add(record["key"])
        records.append(record)
    return records


def load_catalog(path: Path) -> list[dict]:
    if not path.is_file():
        raise SystemExit(f"catalog not found: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"{path}: not valid JSON ({error})")
    return records_from_payload(payload, str(path))


def load_from_loader(sources: Path) -> list[dict]:
    """Run the loader and read its envelope straight from stdout.

    The CLI is the only component that knows manifest rules; keeping the
    projection through a subprocess means this script never grows a second
    copy of those rules.
    """
    if not LOADER.is_file():
        raise SystemExit(f"loader not found: {LOADER}")
    if not sources.is_file():
        raise SystemExit(f"sources file not found: {sources}")

    command = [
        os.environ.get("NODE_BINARY", "node"),
        str(LOADER),
        "catalog",
        "--json",
        "--skip-invalid",
        "-s",
        str(sources),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            check=False,
        )
    except FileNotFoundError:
        raise SystemExit(
            "node is not on PATH; install Node 22 or pass --catalog <file> instead"
        )

    if not completed.stdout.strip():
        detail = completed.stderr.strip() or f"exit {completed.returncode}"
        raise SystemExit(f"loader produced no output: {detail}")

    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        raise SystemExit(
            "loader output is not JSON:\n" + completed.stdout.strip()[:800]
        )
    return records_from_payload(payload, str(sources))


def build_records(source: Path) -> list[dict]:
    records: list[dict] = []
    for index, entry in enumerate(load_marketplace(source), start=1):
        package = plugin_dir(source, entry)
        server = first_mcp_server(package)
        if server is None:
            continue
        server_name, config = server
        display = display_of(package)
        name = (
            display.get("name")
            or display.get("name_en")
            or entry.get("name")
            or server_name
        )
        # ``display.description`` is the English copy; keep Chinese first for the
        # zh-Hans UI, then fall back to whatever the manifest shipped.
        description = (
            display.get("description_zh")
            or display.get("description")
            or display.get("description_en")
            or entry.get("description")
            or ""
        )
        is_remote = bool(config.get("url"))
        records.append(
            {
                "category": classify(str(name), str(description)),
                "name": str(name)[:200],
                "key": str(entry.get("name") or package.name)[:128],
                "description": str(description),
                "home_page": "",
                "type": TYPE_REMOTE if is_remote else TYPE_LOCAL,
                "status": STATUS_ONLINE,
                "sort": index,
                "server_name": server_name[:128],
                "install_command": runtime_install_command(config),
            }
        )
    return records


def summarize(records: list[dict]) -> None:
    by_category: dict[str, int] = {}
    for record in records:
        by_category[record["category"]] = by_category.get(record["category"], 0) + 1
    remote = sum(1 for r in records if r["type"] == TYPE_REMOTE)
    print(f"total records : {len(records)}")
    print(f"remote (url)  : {remote}")
    print(f"local (cmd)   : {len(records) - remote}")
    print("by category   :")
    for category, count in sorted(by_category.items(), key=lambda kv: -kv[1]):
        print(f"  {category}: {count}")


def database_url() -> str:
    url = os.environ.get("database_url")
    if url:
        return url
    env_file = Path(__file__).resolve().parents[1] / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("database_url="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("database_url not configured (env or server/.env)")


def apply_records(records: list[dict]) -> None:
    try:
        import psycopg2
        from psycopg2.extras import Json
    except ImportError:
        raise SystemExit(
            "psycopg2 is required for --apply: "
            "uv run --project server python server/scripts/seed_mcp_market.py --apply"
        )

    connection = psycopg2.connect(database_url())
    connection.autocommit = False
    inserted_mcp = 0
    skipped_mcp = 0
    try:
        with connection.cursor() as cursor:
            cursor.execute("select id, name from category")
            category_ids = {name: category_id for category_id, name in cursor.fetchall()}
            for name in sorted({record["category"] for record in records}):
                if name in category_ids:
                    continue
                cursor.execute(
                    "insert into category (name, description, priority) "
                    "values (%s, %s, %s) returning id",
                    (name, f"由市场目录导入：{name}", 100),
                )
                category_ids[name] = cursor.fetchone()[0]

            cursor.execute("select key from mcp")
            existing_keys = {row[0] for row in cursor.fetchall() if row[0]}
            for record in records:
                if record["key"] in existing_keys:
                    skipped_mcp += 1
                    continue
                cursor.execute(
                    "insert into mcp (category_id, name, key, description, home_page, "
                    "type, status, sort, server_name, install_command) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        category_ids[record["category"]],
                        record["name"],
                        record["key"],
                        record["description"],
                        record["home_page"],
                        record["type"],
                        record["status"],
                        record["sort"],
                        record["server_name"],
                        Json(record["install_command"]),
                    ),
                )
                existing_keys.add(record["key"])
                inserted_mcp += 1
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    print(f"inserted mcp  : {inserted_mcp}")
    print(f"skipped (dupe): {skipped_mcp}")


STARTER_RECORDS: list[dict] = [
    {
        "category": "AI 与搜索",
        "name": "DeepWiki",
        "key": "deepwiki",
        "description": "检索 GitHub 仓库文档并做问答（远程 MCP，无需鉴权）",
        "home_page": "https://deepwiki.com",
        "type": TYPE_REMOTE,
        "status": STATUS_ONLINE,
        "sort": 10,
        "server_name": "deepwiki",
        "install_command": {"url": "https://mcp.deepwiki.com/mcp"},
    },
    {
        "category": "AI 与搜索",
        "name": "Context7",
        "key": "context7",
        "description": "拉取最新的库文档与代码示例（远程 MCP，无需鉴权）",
        "home_page": "https://context7.com",
        "type": TYPE_REMOTE,
        "status": STATUS_ONLINE,
        "sort": 20,
        "server_name": "context7",
        "install_command": {"url": "https://mcp.context7.com/mcp"},
    },
    {
        "category": "开发工具",
        "name": "网页抓取",
        "key": "fetch",
        "description": "抓取网页并转成 Markdown（本地 MCP，需要 uvx）",
        "home_page": "",
        "type": TYPE_LOCAL,
        "status": STATUS_ONLINE,
        "sort": 30,
        "server_name": "fetch",
        "install_command": {"command": "uvx", "args": ["mcp-server-fetch"]},
    },
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    origin = parser.add_mutually_exclusive_group()
    origin.add_argument(
        "--starter",
        action="store_true",
        help="seed the 3 curated rows below (default when no source is given)",
    )
    origin.add_argument(
        "--catalog",
        type=Path,
        metavar="FILE",
        help="rows produced by 'mcp-market/src/cli.js catalog --out'",
    )
    origin.add_argument(
        "--from-loader",
        action="store_true",
        help="run the loader (node mcp-market/src/cli.js catalog) and read its rows",
    )
    origin.add_argument(
        "--marketplace",
        "--source",
        dest="marketplace",
        type=Path,
        metavar="DIR",
        help="WorkBuddy-style connector marketplace directory to import",
    )
    parser.add_argument(
        "--sources",
        type=Path,
        default=LOCAL_SOURCES,
        help=f"sources file for --from-loader (default: {LOCAL_SOURCES})",
    )
    parser.add_argument("--apply", action="store_true", help="write rows (default: preview only)")
    parser.add_argument("--sample", type=int, default=5, help="preview sample size")
    args = parser.parse_args(argv)

    try:
        if args.catalog:
            records = load_catalog(args.catalog.expanduser())
        elif args.from_loader:
            records = load_from_loader(args.sources.expanduser())
        elif args.marketplace:
            source = args.marketplace.expanduser()
            if not source.is_dir():
                raise SystemExit(f"marketplace directory not found: {source}")
            records = build_records(source)
            if not records:
                raise SystemExit("no plugin carried an mcp.json; nothing to import")
        else:
            print("no source given; seeding the 3-row starter set")
            print("  more: --from-loader  |  --catalog FILE  |  --marketplace DIR")
            print()
            records = list(STARTER_RECORDS)
    except CatalogSchemaMismatch as error:
        raise SystemExit(f"refusing to seed: {error}")

    if not records:
        raise SystemExit("no usable record; nothing to write")

    summarize(records)
    print("\nsample:")
    for record in records[: max(args.sample, 0)]:
        print(json.dumps(record, ensure_ascii=False))

    if not args.apply:
        print("\npreview only; re-run with --apply to write rows")
        return 0

    apply_records(records)
    return 0


if __name__ == "__main__":
    sys.exit(main())
