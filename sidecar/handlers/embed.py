"""Embedding handler — generates text embeddings via sentence-transformers."""

import sys
from sentence_transformers import SentenceTransformer

# Load model once at import time (startup), not per request
_model: SentenceTransformer | None = None

EMBED_MODEL_NAME = "nomic-ai/nomic-embed-text-v1.5"
EMBED_DIM = 768


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        print(f"[sidecar] Loading embedding model: {EMBED_MODEL_NAME}", file=sys.stderr)
        _model = SentenceTransformer(EMBED_MODEL_NAME, trust_remote_code=True)
        print(f"[sidecar] Embedding model loaded successfully", file=sys.stderr)
    return _model


async def embed(text: str) -> list[float]:
    """Generate a 768-dim embedding for the given text.

    Method: embed
    Params: {"text": "some text to embed"}
    Returns: list of 768 floats
    """
    model = _get_model()
    # nomic-embed-text expects a search_document: or search_query: prefix
    prefixed = f"search_document: {text}"
    embedding = model.encode(prefixed, normalize_embeddings=True)
    return embedding.tolist()
