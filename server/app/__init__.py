"""
server/app/__init__.py
======================
Flask application factory + HTTP routes for the OpenClaw token-hub.

The app is the *only* component that talks to both the OpenClaw
Gateway (Next.js) and the encrypted token vault. End-users (the
React client) speak exclusively to this server.

Surface:

    GET  /api/health                       liveness probe
    POST /api/users                        create a demo user (dev-only)
    GET  /api/users/<id>                   fetch user summary
    GET  /api/users/<id>/connections       list service connections
    POST /api/users/<id>/connections       connect a service (stores mock token)
    POST /api/users/<id>/connections/<svc>/revoke
                                            disconnect a service
    GET  /api/audit                        recent audit log entries
    POST /api/agent/chat                   proxy a chat to the OpenClaw gateway

The chat endpoint is the *meaningful integration point* between the
hub and the OpenClaw Gateway:

    user -> Flask /api/agent/chat -> OpenClaw Gateway /api/gateway/chat
         -> Ollama -> tool call -> mock Gmail tool -> response
         -> Flask records an audit log row -> response to user
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

from . import audit
from .config import (
    DATABASE_URL,
    GATEWAY_CHAT_URL,
    GATEWAY_TIMEOUT_SECONDS,
    SECRET_KEY,
    USE_SQLITE,
)
from .models import Connection, User, db
from .vault import (
    get_plaintext_access_token,
    has_token,
    revoke_token,
    store_token,
)


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = DATABASE_URL
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["SECRET_KEY"] = SECRET_KEY
    if USE_SQLITE:
        # SQLite doesn't support timezone-aware datetimes out of the
        # box; the simplest fix is to disable the engine-level check.
        app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
            "connect_args": {"check_same_thread": False}
        }

    CORS(app)  # dev: open CORS so the Vite client can call us
    db.init_app(app)

    with app.app_context():
        db.create_all()
        _seed_demo_user_if_needed()

    _register_routes(app)
    return app


# --- helpers --------------------------------------------------------------


def _err(message: str, status: int = 400, **extra: Any):
    body = {"ok": False, "error": message}
    body.update(extra)
    return jsonify(body), status


def _get_user_or_404(user_id: str) -> Optional[User]:
    return db.session.get(User, user_id)


def _seed_demo_user_if_needed() -> None:
    """Ensure a stable demo user exists so the React client has
    something to talk to in dev. This is a no-op once a user with
    email ``demo@openclaw.local`` is present."""
    if User.query.filter_by(email="demo@openclaw.local").first() is not None:
        return
    demo = User(
        id="00000000-0000-0000-0000-000000000001",
        email="demo@openclaw.local",
        display_name="Demo User",
    )
    db.session.add(demo)
    db.session.commit()


# --- routes ---------------------------------------------------------------


def _register_routes(app: Flask) -> None:

    # ---- health ---------------------------------------------------------

    @app.get("/api/health")
    def health():
        return jsonify({
            "ok": True,
            "service": "openclaw-token-hub",
            "version": "0.1.0",
        })

    # ---- users ----------------------------------------------------------

    @app.post("/api/users")
    def create_user():
        payload = request.get_json(silent=True) or {}
        email = (payload.get("email") or "").strip().lower()
        display_name = (payload.get("display_name") or "").strip() or None
        if not email or "@" not in email:
            return _err("Invalid email", 400)
        if User.query.filter_by(email=email).first() is not None:
            return _err("User already exists", 409)
        user = User(id=str(uuid.uuid4()), email=email, display_name=display_name)
        db.session.add(user)
        db.session.commit()
        return jsonify({"ok": True, "user": user.to_dict()}), 201

    @app.get("/api/users/<user_id>")
    def get_user(user_id: str):
        user = _get_user_or_404(user_id)
        if user is None:
            return _err("User not found", 404)
        return jsonify({"ok": True, "user": user.to_dict()})

    # ---- connections ----------------------------------------------------

    @app.get("/api/users/<user_id>/connections")
    def list_connections(user_id: str):
        user = _get_user_or_404(user_id)
        if user is None:
            return _err("User not found", 404)
        items = [
            {**c.to_dict(), "has_token": has_token(user_id, c.service)}
            for c in user.connections
        ]
        return jsonify({"ok": True, "connections": items})

    @app.post("/api/users/<user_id>/connections")
    def connect_service(user_id: str):
        user = _get_user_or_404(user_id)
        if user is None:
            return _err("User not found", 404)
        payload = request.get_json(silent=True) or {}
        service = (payload.get("service") or "").strip().lower()
        scope = (payload.get("scope") or "").strip() or None
        # In real life this would come from a CIBA / OAuth callback.
        # For the demo we accept a token directly so the flow is
        # testable end-to-end without an external IdP.
        access_token = (payload.get("access_token") or "").strip()
        if not service:
            return _err("service is required", 400)
        if not access_token:
            return _err("access_token is required (demo only)", 400)

        store_token(user_id=user_id, service=service, access_token=access_token, scope=scope)
        conn = Connection.query.filter_by(user_id=user_id, service=service).first()
        if conn is None:
            conn = Connection(user_id=user_id, service=service, status="connected",
                              granted_scopes=scope)
            db.session.add(conn)
            db.session.commit()
        else:
            conn.status = "connected"
            if scope:
                conn.granted_scopes = scope
            db.session.commit()

        audit.record(
            action="connection.connect",
            user_id=user_id,
            tool_name=service,
            arguments={"scope": scope},
            result_status="ok",
        )
        return jsonify({"ok": True, "connection": conn.to_dict()}), 201

    @app.post("/api/users/<user_id>/connections/<service>/revoke")
    def revoke_connection(user_id: str, service: str):
        user = _get_user_or_404(user_id)
        if user is None:
            return _err("User not found", 404)
        conn = Connection.query.filter_by(user_id=user_id, service=service).first()
        if conn is None:
            return _err("Connection not found", 404)
        revoke_token(user_id=user_id, service=service)
        conn.status = "revoked"
        db.session.commit()
        audit.record(
            action="connection.revoke",
            user_id=user_id,
            tool_name=service,
            result_status="ok",
        )
        return jsonify({"ok": True, "connection": conn.to_dict()})

    # ---- audit ----------------------------------------------------------

    @app.get("/api/audit")
    def list_audit():
        limit = int(request.args.get("limit", 50))
        user_id = request.args.get("user_id")
        rows = audit.list_recent(limit=limit, user_id=user_id)
        return jsonify({"ok": True, "entries": [r.to_dict() for r in rows]})

    # ---- agent chat (the integration endpoint) -------------------------

    @app.post("/api/agent/chat")
    def agent_chat():
        payload = request.get_json(silent=True) or {}
        message = (payload.get("message") or "").strip()
        user_id = (payload.get("user_id") or "").strip() or None
        session_id = (payload.get("session_id") or "").strip() or None

        if not message:
            return _err("message is required", 400)
        if user_id is not None and _get_user_or_404(user_id) is None:
            return _err("Unknown user_id", 404)

        try:
            upstream = requests.post(
                GATEWAY_CHAT_URL,
                json={"message": message},
                timeout=GATEWAY_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            audit.record(
                action="agent.run",
                user_id=user_id,
                session_id=session_id,
                result_status="error",
                message=message,
                result={"error": f"gateway unreachable: {exc}"},
            )
            return _err("Gateway unreachable", 502, details=str(exc))

        # The gateway always returns JSON, even on errors.
        try:
            upstream_json = upstream.json()
        except ValueError:
            audit.record(
                action="agent.run",
                user_id=user_id,
                session_id=session_id,
                result_status="error",
                message=message,
                result={"status": upstream.status_code, "body": upstream.text[:500]},
            )
            return _err("Gateway returned non-JSON", 502)

        if not upstream.ok:
            audit.record(
                action="agent.run",
                user_id=user_id,
                session_id=session_id,
                result_status="error",
                message=message,
                result=upstream_json,
            )
            return jsonify({"ok": False, "error": "Gateway error",
                            "details": upstream_json}), upstream.status_code

        # Successful gateway run. Record the audit trail.
        kind = upstream_json.get("kind")
        audit_args = {
            "action": "agent.run",
            "user_id": user_id,
            "session_id": session_id,
            "message": message,
            "result_status": "ok",
            "result": {
                "kind": kind,
                "model": upstream_json.get("model"),
            },
        }
        if kind == "tool":
            audit_args["tool_name"] = upstream_json.get("toolName")
            audit_args["arguments"] = upstream_json.get("arguments")
            audit_args["result"]["tool_result"] = upstream_json.get("result")

            # Record a second, more specific row for the tool itself so
            # the audit page can show "tool.read_email" lines.
            audit.record(
                action=f"tool.{upstream_json.get('toolName')}",
                user_id=user_id,
                session_id=session_id,
                tool_name=upstream_json.get("toolName"),
                arguments=upstream_json.get("arguments"),
                result_status="ok",
                result=upstream_json.get("result"),
            )
        audit.record(**audit_args)

        return jsonify({"ok": True, "gateway": upstream_json})

    # ---- a tiny token-vault inspector (for debugging) -------------------

    @app.get("/api/users/<user_id>/vault/<service>")
    def vault_inspect(user_id: str, service: str):
        """Returns whether a token exists and (optionally) a redacted
        prefix. NEVER returns the plaintext."""
        user = _get_user_or_404(user_id)
        if user is None:
            return _err("User not found", 404)
        token = get_plaintext_access_token(user_id, service)
        if token is None:
            return jsonify({"ok": True, "has_token": False})
        redacted = token[:4] + "..." + token[-4:] if len(token) > 8 else "***"
        return jsonify({"ok": True, "has_token": True, "redacted": redacted})


# WSGI entry point used by gunicorn: ``gunicorn wsgi:app``.
app = create_app()
