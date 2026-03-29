"""Add SaaS models: User, UsageRecord, user_id FK on existing tables

Revision ID: 001
Revises: None
Create Date: 2026-03-29

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create users table
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("email", sa.String(255), unique=True, index=True, nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("plan", sa.String(20), server_default="free", nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("email_verified", sa.Boolean(), server_default="0", nullable=False),
        sa.Column("email_verification_token", sa.String(255), nullable=True),
        sa.Column("password_reset_token", sa.String(255), nullable=True),
        sa.Column("password_reset_expires", sa.DateTime(), nullable=True),
        sa.Column("promo_consent", sa.Boolean(), server_default="0", nullable=False),
        sa.Column("stripe_customer_id", sa.String(255), nullable=True),
        sa.Column("stripe_subscription_id", sa.String(255), nullable=True),
        sa.Column("subscription_status", sa.String(50), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )

    # Create usage_records table
    op.create_table(
        "usage_records",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), index=True, nullable=False),
        sa.Column("date", sa.String(10), index=True, nullable=False),
        sa.Column("removals", sa.Integer(), server_default="0", nullable=False),
        sa.Column("scans", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    # Add user_id to existing tables (nullable for backwards compat)
    op.add_column("followers", sa.Column("user_id", sa.Integer(), nullable=True))
    op.create_index("ix_followers_user_id", "followers", ["user_id"])

    op.add_column("action_logs", sa.Column("user_id", sa.Integer(), nullable=True))
    op.create_index("ix_action_logs_user_id", "action_logs", ["user_id"])

    op.add_column("scan_sessions", sa.Column("user_id", sa.Integer(), nullable=True))
    op.create_index("ix_scan_sessions_user_id", "scan_sessions", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_scan_sessions_user_id", "scan_sessions")
    op.drop_column("scan_sessions", "user_id")

    op.drop_index("ix_action_logs_user_id", "action_logs")
    op.drop_column("action_logs", "user_id")

    op.drop_index("ix_followers_user_id", "followers")
    op.drop_column("followers", "user_id")

    op.drop_table("usage_records")
    op.drop_table("users")
