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

"""Ask a remote MCP server what it wants, using the same code the UI runs.

`ConnectorGateway.installMarketItem` decides between three buttons from one
answer: install quietly, ask for a key, or open a browser to log in. That
decision comes from `mcp_oauth.probe`, so a curl that only prints a status code
can disagree with the app. This prints the answer the app acts on.

Read-only: it sends one `initialize` and never writes `~/.eigent/mcp.json`.

    python backend/scripts/probe_mcp.py https://mcp.notion.com/mcp
    python backend/scripts/probe_mcp.py --json https://afg.ai/mcp
"""

import argparse
import json
import sys
from pathlib import Path

# Import the app package without requiring an activated venv or a cd.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.service import mcp_oauth  # noqa: E402

UI_ACTION = {
    "open": "直接安装",
    "auth_required": "弹登录授权（开浏览器）",
    "unsupported": "装不了：要求鉴权但没给授权地址",
    "unreachable": "连不上（检查地址/网络）",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("urls", nargs="+", help="MCP endpoint URLs")
    parser.add_argument(
        "--json", action="store_true", help="emit raw results as JSON"
    )
    args = parser.parse_args()

    results = []
    for url in args.urls:
        try:
            found = mcp_oauth.probe(url)
        except Exception as error:  # noqa: BLE001 - a probe must not crash on one URL
            found = {
                "outcome": "unreachable",
                "detail": f"{type(error).__name__}: {error}",
            }
        results.append({"url": url, **found})
        if not args.json:
            outcome = found.get("outcome", "?")
            print(f"{url}\n  outcome: {outcome}  -> {UI_ACTION.get(outcome, '?')}")
            if found.get("authorization_server"):
                print(f"  authorize at: {found['authorization_server']}")
            if found.get("scopes"):
                print(f"  scopes: {' '.join(found['scopes'])}")
            if found.get("detail"):
                print(f"  detail: {found['detail']}")
            print()

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
