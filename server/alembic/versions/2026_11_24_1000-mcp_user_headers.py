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

"""Give an installed MCP a place to keep its request headers.

Revision ID: mcp_user_headers
Revises: provider_execution_revision

A remote MCP behind an API key needs a header on every request. Until now the
install path copied command / url / args / env and the row had nowhere to put
headers, so an authenticated remote server installed and then answered 401
forever. Nullable with no backfill: existing rows genuinely have no headers to
recover, and NULL means "installed before this column existed", which is a fact
worth keeping instead of inventing an empty object for.
"""

import sqlalchemy as sa

from alembic import op

revision = "mcp_user_headers"
down_revision = "provider_execution_revision"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "mcp_user",
        sa.Column("headers", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("mcp_user", "headers")
