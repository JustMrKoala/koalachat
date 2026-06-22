import os
from pathlib import Path


class Settings:
    def __init__(self):
        self.env = os.environ.get("KOALA_ENV", "development")
        self.host = os.environ.get("KOALA_HOST", "0.0.0.0")
        self.port = int(os.environ.get("KOALA_PORT", "8999"))
        self.ssl_cert = os.environ.get("SSL_CERT", "")
        self.ssl_key = os.environ.get("SSL_KEY", "")
        frontend_override = os.environ.get("KOALA_FRONTEND_DIR", "").strip()
        self.frontend_dir = (
            Path(frontend_override) if frontend_override else Path(__file__).parent.parent / "frontend"
        )
        self.tls_subject = os.environ.get("TLS_SUBJECT", "/CN=koalachat.local/O=KoalaChat/C=US")
        self.workers = int(os.environ.get("KOALA_WORKERS", "1"))
        self.log_level = os.environ.get("KOALA_LOG_LEVEL", "info")
        self.allowed_origins = os.environ.get("KOALA_ALLOWED_ORIGINS", "")

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def cors_origins(self) -> list[str]:
        if not self.allowed_origins:
            return []
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


settings = Settings()