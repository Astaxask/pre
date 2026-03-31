"""Tests for the embedding handler."""

import asyncio
import pytest

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from handlers.embed import embed, EMBED_DIM


class TestEmbed:
    def test_returns_list_of_floats(self):
        result = asyncio.get_event_loop().run_until_complete(
            embed("A financial transaction at a restaurant")
        )
        assert isinstance(result, list)
        assert len(result) == EMBED_DIM
        assert all(isinstance(x, float) for x in result)

    def test_returns_768_dimensions(self):
        result = asyncio.get_event_loop().run_until_complete(
            embed("Test embedding dimensions")
        )
        assert len(result) == 768

    def test_different_texts_produce_different_embeddings(self):
        r1 = asyncio.get_event_loop().run_until_complete(embed("restaurant spending"))
        r2 = asyncio.get_event_loop().run_until_complete(embed("morning exercise routine"))
        # They should not be identical
        assert r1 != r2

    def test_embeddings_are_normalized(self):
        result = asyncio.get_event_loop().run_until_complete(embed("normalized test"))
        # L2 norm should be approximately 1.0 (since we use normalize_embeddings=True)
        import math
        norm = math.sqrt(sum(x * x for x in result))
        assert abs(norm - 1.0) < 0.01
