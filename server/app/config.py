"""
server/app/config.py
====================
Centralised configuration for the OpenClaw token-hub server.

All environment-driven values are resolved once at import time so
that the rest of the codebase can rely on simple, typed constants
without re-reading the environment on every request.
"""

import os


def _env(name: str, default: str = "") -> str:
    """Read an env var, falling back to ``default`` if unset/empty."""
    value = os.environ.get(name)
    return value if value is not None and value != "" else default


# --- Database -------------------------------------------------------------

POSTGRES_USER: str = _env("POSTGRES_USER", "openclaw")
POSTGRES_PASSWORD: str = _env("POSTGRES_PASSWORD", "openclaw")
POSTGRES_DB: str = _env("POSTGRES_DB", "openclaw")
POSTGRES_PORT: int = int(_env("POSTGRES_PORT", "5432"))
POSTGRES_HOST: str = _env("POSTGRES_HOST", "localhost")

DATABASE_URL: str = _env(
    "DATABASE_URL",
    f"postgresql+psycopg2://{POSTGRES_USER}:{POSTGRES_PASSWORD}"
    f"@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}",
)

# A SQLite URL is also supported for fully-local development without
# a running Postgres instance. Set ``USE_SQLITE=1`` to enable.
USE_SQLITE: bool = _env("USE_SQLITE", "0") == "1"
if USE_SQLITE:
    DATABASE_URL = "sqlite:///./openclaw.db"


# --- Token vault ----------------------------------------------------------

# 32-byte url-safe base64 key used by Fernet to encrypt OAuth tokens
# at rest. In production this MUST be loaded from a secret manager.
# We auto-generate one in dev to make the demo runnable out of the
# box; the generated key is written to ``./.vault.key`` so it is
# stable across restarts.
def _load_or_create_vault_key() -> str:
    key_file = os.path.join(os.path.dirname(__file__), "..", ".vault.key")
    key_file = os.path.abspath(key_file)
    existing = _env("VAULT_KEY", "")
    if existing:
        return existing
    try:
        with open(key_file, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except FileNotFoundError:
        pass
    # Lazy import so the rest of the module can be imported by tools
    # (e.g. gunicorn) that don't necessarily have cryptography
    # installed for non-vault use cases.
    from cryptography.fernet import Fernet  # type: ignore

    new_key = Fernet.generate_key().decode("utf-8")
    try:
        with open(key_file, "w", encoding="utf-8") as fh:
            fh.write(new_key)
    except OSError:
        # If we can't persist the key (e.g. read-only FS), the
        # current process will still work for its lifetime.
        pass
    return new_key


VAULT_KEY: str = _load_or_create_vault_key()


# --- OpenClaw Gateway (Next.js) ------------------------------------------

# The internal URL of the OpenClaw Gateway chat endpoint. The Flask
# server is the only component authorised to call this; end users
# never see the gateway directly.
GATEWAY_CHAT_URL: str = _env(
    "GATEWAY_CHAT_URL",
    "http://localhost:3002/api/gateway/chat",
)
GATEWAY_TIMEOUT_SECONDS: float = float(_env("GATEWAY_TIMEOUT_SECONDS", "60"))


# --- Misc -----------------------------------------------------------------

FLASK_ENV: str = _env("FLASK_ENV", "development")
SECRET_KEY: str = _env("FLASK_SECRET", "dev-secret-change-me")
