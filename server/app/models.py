"""
server/app/models.py
====================
SQLAlchemy ORM models backing the OpenClaw token-hub:

* ``User``               - end-user authenticated against the gateway
* ``OAuthToken``         - encrypted OAuth token issued by an external
                           IdP (Google, GitHub, Slack, ...) and stored
                           in the local token vault
* ``Connection``         - high-level "is this service connected for
                           this user?" lookup used by the dashboard
* ``AuditLog``           - append-only record of every gateway action
"""

from __future__ import annotations

import datetime as _dt
import uuid

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def _uuid() -> str:
    return str(uuid.uuid4())


def _utcnow() -> _dt.datetime:
    return _dt.datetime.now(tz=_dt.timezone.utc)


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.String(36), primary_key=True, default=_uuid)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    display_name = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)

    tokens = db.relationship("OAuthToken", backref="user", cascade="all, delete-orphan")
    connections = db.relationship("Connection", backref="user", cascade="all, delete-orphan")
    audit_entries = db.relationship("AuditLog", backref="user", cascade="all, delete-orphan")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "email": self.email,
            "display_name": self.display_name,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class OAuthToken(db.Model):
    """A Fernet-encrypted OAuth access (and optional refresh) token.

    The ``access_token_ciphertext`` / ``refresh_token_ciphertext`` fields
    store the *encrypted* form. Plaintext only ever lives in memory,
    inside the vault helper, at the moment a request needs it.
    """

    __tablename__ = "oauth_tokens"

    id = db.Column(db.String(36), primary_key=True, default=_uuid)
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)
    service = db.Column(db.String(64), nullable=False, index=True)  # e.g. "google"
    scope = db.Column(db.String(512), nullable=True)
    access_token_ciphertext = db.Column(db.Text, nullable=False)
    refresh_token_ciphertext = db.Column(db.Text, nullable=True)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    __table_args__ = (
        db.UniqueConstraint("user_id", "service", name="uq_user_service"),
    )

    def to_summary(self) -> dict:
        """Safe-for-API summary. NEVER includes the ciphertext."""
        return {
            "id": self.id,
            "service": self.service,
            "scope": self.scope,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class Connection(db.Model):
    """A user-facing "service connection" record shown in the dashboard.

    Decoupled from ``OAuthToken`` so we can represent a connection that
    the user has explicitly authorised even before any token has been
    materialised, and so the dashboard can show a stable "connected"
    flag for services the model is allowed to call.
    """

    __tablename__ = "connections"

    id = db.Column(db.String(36), primary_key=True, default=_uuid)
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)
    service = db.Column(db.String(64), nullable=False)  # "gmail", "github", "slack", ...
    status = db.Column(db.String(32), nullable=False, default="connected")
    granted_scopes = db.Column(db.String(512), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)

    __table_args__ = (
        db.UniqueConstraint("user_id", "service", name="uq_connection_user_service"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "service": self.service,
            "status": self.status,
            "granted_scopes": self.granted_scopes,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class AuditLog(db.Model):
    """Append-only audit trail of every agent action.

    Captures:
      * who acted (user_id, optional session_id)
      * what the model said vs. what tool was invoked
      * the result status
      * the high-level tool name + arguments snapshot
    """

    __tablename__ = "audit_log"

    id = db.Column(db.String(36), primary_key=True, default=_uuid)
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=True, index=True)
    session_id = db.Column(db.String(64), nullable=True, index=True)
    action = db.Column(db.String(64), nullable=False)        # "agent.run", "tool.read_email", ...
    tool_name = db.Column(db.String(64), nullable=True)
    arguments_json = db.Column(db.Text, nullable=True)
    result_status = db.Column(db.String(32), nullable=False)  # "ok" | "error"
    result_json = db.Column(db.Text, nullable=True)
    message = db.Column(db.Text, nullable=True)               # original user message
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False, index=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "action": self.action,
            "tool_name": self.tool_name,
            "arguments": self.arguments_json,
            "result_status": self.result_status,
            "result": self.result_json,
            "message": self.message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
