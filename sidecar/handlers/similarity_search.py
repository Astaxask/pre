"""Similarity search and vector upsert via LanceDB."""

import os
import sys
import lancedb
import pyarrow as pa
import numpy as np

LANCEDB_PATH = os.environ.get("PRE_LANCEDB_PATH", os.path.expanduser("~/.pre/lancedb"))
TABLE_NAME = "events_vectors"
EMBED_DIM = 768

_db: lancedb.DBConnection | None = None


def _get_db() -> lancedb.DBConnection:
    global _db
    if _db is None:
        print(f"[sidecar] Opening LanceDB at: {LANCEDB_PATH}", file=sys.stderr)
        _db = lancedb.connect(LANCEDB_PATH)
    return _db


def _ensure_table(db: lancedb.DBConnection) -> lancedb.table.Table:
    """Get or create the events_vectors table."""
    if TABLE_NAME in db.table_names():
        return db.open_table(TABLE_NAME)

    # Create with schema
    schema = pa.schema([
        pa.field("id", pa.string()),
        pa.field("vector", pa.list_(pa.float32(), EMBED_DIM)),
        pa.field("domain", pa.string()),
        pa.field("event_type", pa.string()),
        pa.field("timestamp", pa.int64()),
        pa.field("summary", pa.string()),
    ])
    return db.create_table(TABLE_NAME, schema=schema)


async def upsert_vector(
    id: str,
    embedding: list[float],
    metadata: dict,
) -> None:
    """Insert or update a vector in LanceDB.

    Method: upsert_vector
    Params: {"id": "...", "embedding": [...], "metadata": {"domain": ..., ...}}
    """
    db = _get_db()
    table = _ensure_table(db)

    data = [{
        "id": id,
        "vector": embedding,
        "domain": metadata.get("domain", ""),
        "event_type": metadata.get("eventType", ""),
        "timestamp": metadata.get("timestamp", 0),
        "summary": metadata.get("summary", ""),
    }]

    # Try to delete existing row first (upsert behavior)
    try:
        table.delete(f'id = "{id}"')
    except Exception:
        pass  # Table might be empty or row doesn't exist

    table.add(data)


async def similarity_search(
    query_embedding: list[float],
    top_k: int = 10,
    domains: list[str] | None = None,
    lancedb_path: str | None = None,
) -> list[dict]:
    """Search for similar events by embedding vector.

    Method: similarity_search
    Params: {
        "query_embedding": [...],
        "top_k": 10,
        "domains": ["money", "body"] | null
    }
    Returns: list of dicts with id, domain, eventType, timestamp, summary
    """
    global _db, LANCEDB_PATH

    # Allow overriding path via params (for tests)
    if lancedb_path and lancedb_path != LANCEDB_PATH:
        LANCEDB_PATH = lancedb_path
        _db = None

    db = _get_db()

    if TABLE_NAME not in db.table_names():
        return []

    table = _ensure_table(db)

    query = table.search(query_embedding).limit(top_k)

    if domains:
        domain_filter = " OR ".join(f'domain = "{d}"' for d in domains)
        query = query.where(f"({domain_filter})")

    results = query.to_list()

    return [
        {
            "id": row["id"],
            "domain": row["domain"],
            "eventType": row["event_type"],
            "timestamp": row["timestamp"],
            "summary": row["summary"],
        }
        for row in results
    ]
