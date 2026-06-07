"""
server/app/vault.py
====================
Fernet-encrypted token vault.

The vault is the ONLY place in the server that handles plaintext
OAuth tokens. The rest of the codebase talks to ``store_token`` /
``get_token`` and only ever sees ciphertext when it goes to the DB.
"""

from __future__ import annotations

import datetime as _dt
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from .config import VAULT_KEY
from .models import OAuthToken, db

_fernet = Fernet(VAULT_KEY.encode("utf-8"))


def _encrypt(plaintext: str) -> str:
    if plaintext is None:
        raise ValueError("Cannot encrypt None")
    return _fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")


def _decrypt(ciphertext: str) -> str:
    if not ciphertext:
        raise ValueError("Cannot decrypt empty ciphertext")
    try:
        return _fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:  # pragma: no cover - depends on key
        raise RuntimeError("Failed to decrypt token (vault key changed?)") from exc


def store_token(
    user_id: str,
    service: str,
    access_token: str,
    refresh_token: Optional[str] = None,
    scope: Optional[str] = None,
    expires_at: Optional[_dt.datetime] = None,
) -> OAuthToken:
    """Insert or update the encrypted token for ``(user_id, service)``."""
    record = OAuthToken.query.filter_by(user_id=user_id, service=service).first()
    if record is None:
        record = OAuthToken(
            user_id=user_id,
            service=service,
            access_token_ciphertext=_encrypt(access_token),
            refresh_token_ciphertext=_encrypt(refresh_token) if refresh_token else None,
            scope=scope,
            expires_at=expires_at,
        )
        db.session.add(record)
    else:
        record.access_token_ciphertext = _encrypt(access_token)
        if refresh_token is not None:
            record.refresh_token_ciphertext = _encrypt(refresh_token)
        if scope is not None:
            record.scope = scope
        if expires_at is not None:
            record.expires_at = expires_at
    db.session.commit()
    return record


def get_plaintext_access_token(user_id: str, service: str) -> Optional[str]:
    """Return the plaintext access token for ``(user_id, service)``.

    Returns ``None`` if no token has been stored. Raises on decryption
    failure (which would mean a key mismatch).
    """
    record = OAuthToken.query.filter_by(user_id=user_id, service=service).first()
    if record is None:
        return None
    return _decrypt(record.access_token_ciphertext)


def has_token(user_id: str, service: str) -> bool:
    return (
        OAuthToken.query.filter_by(user_id=user_id, service=service).first() is not None
    )


def revoke_token(user_id: str, service: str) -> bool:
    record = OAuthToken.query.filter_by(user_id=user_id, service=service).first()
    if record is None:
        return False
    db.session.delete(record)
    db.session.commit()
    return True
