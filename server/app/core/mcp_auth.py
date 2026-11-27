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

"""The one function that copies a remote server's auth map.

A remote MCP authenticates with ``headers`` (http transports) or ``env``
(local ones). Both are "a dict of secrets the catalogue only sketched", and
both have to be copied the same way:

* the key survives, even when the value is unknown -- an empty field in the
  install form is a question the user can answer, a missing field is a silent
  401;
* a value that is really documentation (``"{{get one at exa.ai}}"``) is
  blanked rather than forwarded, because the sentence would go out as the
  credential;
* a key with no name is dropped, because it cannot exist on the wire.

This module exists because that paragraph used to be copy-pasted into five
write paths -- ``install``, ``import_mcp``, Brain's ``add_mcp``/``update_mcp``,
the frontend's install dialog, and the placeholder scanner. Five copies meant
five slightly different definitions of "is this a value or a hint": the
scanner knew about ``{{...}}`` but not ``${VAR}``, so a catalogue entry written
as ``${ACME_KEY}`` was blanked by the installer, left untouched by the scanner,
and reported clean. A sixth write path would have invented a sixth definition.

Callers pass the raw catalogue object, never a loop of their own.
"""

from __future__ import annotations

import re

# Both spellings are documentation, not credentials:
#   {{get one at exa.ai}}   -- a sentence in braces (most catalogues)
#   ${EXA_API_KEY}          -- a host-side reference the row cannot resolve
# The second used to be missing from three of the five copies.
HINT = re.compile(r"\{\{|\}\}|\$\{[A-Za-z0-9_]+\}")

WARN_VALUE_BLANKED = "AUTH_VALUE_BLANKED"
WARN_KEY_DROPPED = "AUTH_KEY_DROPPED"


def is_hint(value) -> bool:
    """True when the value is documentation a catalogue published by mistake."""
    return isinstance(value, str) and bool(HINT.search(value))


def carry_auth(src, dst: dict | None = None, *, field: str = "headers"):
    """Copy ``src`` into ``dst`` as a text map, reporting what was changed.

    Returns ``(mapping, warnings)``. ``mapping`` is ``None`` when there is
    nothing to carry, which is what a JSON column wants.

    Warnings are ``{"code", "field", "key", "detail"}`` dicts, not log lines:
    the caller decides whether a blanked value is expected (a catalogue
    placeholder) or alarming (a user's own typo), and the install response can
    name the key the user needs to fill.
    """
    warnings: list[dict] = []
    if src is None:
        return None, warnings
    if not isinstance(src, dict):
        raise McpAuthError(f"MCP_INVALID_{field.upper()}", f"{field} must be an object")

    out: dict[str, str] = {}
    for key, value in src.items():
        name = key.strip() if isinstance(key, str) else ""
        if not name:
            warnings.append(
                {
                    "code": WARN_KEY_DROPPED,
                    "field": field,
                    "key": str(key),
                    "detail": f"{field} key has no name; it cannot be sent",
                }
            )
            continue
        if is_hint(value):
            out[name] = ""
            warnings.append(
                {
                    "code": WARN_VALUE_BLANKED,
                    "field": field,
                    "key": name,
                    "detail": "catalogue hint blanked; the user must supply the value",
                }
            )
            continue
        out[name] = value if isinstance(value, str) else str(value)

    if not out:
        return None, warnings
    return out, warnings


class McpAuthError(ValueError):
    """The auth map cannot be normalized at all."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
