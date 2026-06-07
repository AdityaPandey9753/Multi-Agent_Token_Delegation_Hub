"""
server/app/audit.py
====================
Append-only audit logging.

The audit log is the source of truth for "what did the agent do,
and on whose behalf?". Every call to ``record(...)`` is committed
in its own transaction so partial failures don't drop entries.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from .models import AuditLog, db


def _stringify(payload: Any) -> Optional[str]:
    if payload is None:
        return None
    if isinstance(payload, str):
        return payload
    try:
        return json.dumps(payload, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return json.dumps({"unserialisable": str(payload)})


def record(
    action: str,
    *,
    user_id: Optional[str] = None,
    session_id: Optional[str] = None,
    tool_name: Optional[str] = None,
    arguments: Any = None,
    result_status: str = "ok",
    result: Any = None,
    message: Optional[str] = None,
) -> AuditLog:
    """Append a single audit row and commit it.

    ``result_status`` is constrained to ``"ok"`` / ``"error"`` at the
    call sites; we keep the field open in the DB to allow future
    statuses (``"pending"``, ``"denied"``, ...).
    """
    entry = AuditLog(
        action=action,
        user_id=user_id,
        session_id=session_id,
        tool_name=tool_name,
        arguments_json=_stringify(arguments),
        result_status=result_status,
        result_json=_stringify(result),
        message=message,
    )
    db.session.add(entry)
    db.session.commit()
    return entry


def list_recent(limit: int = 50, user_id: Optional[str] = None) -> list[AuditLog]:
    q = AuditLog.query.order_by(AuditLog.created_at.desc())
    if user_id is not None:
        q = q.filter(AuditLog.user_id == user_id)
    return q.limit(limit).all()
