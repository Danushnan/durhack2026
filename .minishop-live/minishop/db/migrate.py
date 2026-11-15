"""Ordered, checksummed SQL migrations, serialized by a PostgreSQL advisory lock."""
import hashlib
import json
import os
from pathlib import Path
import psycopg

ROOT = Path(__file__).resolve().parent


def migrate(dsn=None):
    with psycopg.connect(dsn or os.environ["DATABASE_URL"]) as conn:
        conn.execute("SELECT pg_advisory_xact_lock(78473629)")
        conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())""")
        for path in sorted((ROOT / "migrations").glob("*.sql")):
            sql = path.read_text()
            checksum = hashlib.sha256(sql.encode()).hexdigest()
            old = conn.execute("SELECT checksum FROM schema_migrations WHERE version=%s", (path.name,)).fetchone()
            if old:
                if old[0] != checksum:
                    raise RuntimeError(f"Applied migration {path.name} changed; add a new migration instead")
                continue
            conn.execute(sql)
            conn.execute("INSERT INTO schema_migrations(version,checksum) VALUES (%s,%s)", (path.name, checksum))
        # Existing products and prices are not overwritten by subsequent deploys.
        for p in json.loads((ROOT / "catalog.json").read_text()):
            conn.execute("""INSERT INTO products (id,name,description,category,price_cents,stock,image_url)
                VALUES (%(id)s,%(name)s,%(description)s,%(category)s,%(price_cents)s,%(stock)s,%(image_url)s)
                ON CONFLICT (id) DO NOTHING""", p)
    print("MiniShop migrations and seed complete")


if __name__ == "__main__":
    migrate()
