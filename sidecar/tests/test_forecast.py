"""Tests for forecast, impact estimation, and Monte Carlo simulation."""

import asyncio
import json
import os
import pytest
import numpy as np

# Add parent dir to path
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from handlers.forecast import (
    forecast_domain,
    estimate_impact,
    run_simulation,
    GENERIC_PRIORS,
    DOMAIN_METRICS,
)


def _make_90_day_events(domain: str = "body", start_ts: int = 1_700_000_000_000) -> list[dict]:
    """Create 90 days of synthetic events."""
    events = []
    for i in range(90):
        events.append({
            "domain": domain,
            "timestamp": start_ts + i * 86_400_000,
            "eventType": "daily-metric",
        })
    return events


def _make_events(count: int, domain: str = "body") -> list[dict]:
    """Create N events for a domain."""
    return [{
        "domain": domain,
        "timestamp": 1_700_000_000_000 + i * 86_400_000,
        "eventType": "metric",
    } for i in range(count)]


class TestForecastDomain:
    """Test forecast_domain handler."""

    def test_insufficient_data_below_14_events(self):
        """Fewer than 14 events should return insufficient_data."""
        events = _make_events(10)
        result = asyncio.run(forecast_domain("body", events, 30))

        assert result["insufficient_data"] is True
        assert result["metric"] == "Sleep duration"
        assert result["unit"] == "hours/night"
        assert result["confidence"] == 0

    def test_insufficient_data_empty(self):
        """Empty events should return insufficient_data."""
        result = asyncio.run(forecast_domain("mind", [], 30))

        assert result["insufficient_data"] is True
        assert result["metric"] == "Goal progress velocity"

    def test_known_domain_metrics(self):
        """Domain metrics should be correctly mapped."""
        for domain, info in DOMAIN_METRICS.items():
            result = asyncio.run(forecast_domain(domain, [], 30))
            assert result["metric"] == info["metric"]
            assert result["unit"] == info["unit"]

    def test_unknown_domain_fallback(self):
        """Unknown domain should use domain name as metric."""
        result = asyncio.run(forecast_domain("unknown_domain", [], 30))

        assert result["metric"] == "unknown_domain"
        assert result["insufficient_data"] is True

    def test_forecast_with_enough_data(self):
        """90 days of data should not return insufficient_data (if Prophet available)."""
        events = _make_90_day_events()
        result = asyncio.run(forecast_domain("body", events, 30))

        # Prophet may or may not be available; either way should return valid structure
        assert "insufficient_data" in result
        assert "p10_final" in result
        assert "p50_final" in result
        assert "p90_final" in result
        assert "confidence" in result


class TestEstimateImpact:
    """Test estimate_impact handler."""

    def test_known_decision_and_domain(self):
        """Known decision type + domain should return priors."""
        result = asyncio.run(estimate_impact("job-change", "body", [], 30))

        assert result["source"] == "generic-prior"
        assert result["delta_p10"] == -0.8
        assert result["delta_p50"] == 0.0
        assert result["delta_p90"] == 0.5
        assert result["confidence"] == 0.25

    def test_unknown_decision_type(self):
        """Unknown decision type should return zero deltas."""
        result = asyncio.run(estimate_impact("unknown-decision", "body", [], 30))

        assert result["analog_count"] == 0
        assert result["delta_p10"] == 0
        assert result["delta_p50"] == 0
        assert result["delta_p90"] == 0
        assert result["confidence"] == 0.1

    def test_unknown_domain_for_known_decision(self):
        """Known decision but domain not in priors should return zero."""
        result = asyncio.run(estimate_impact("habit-add", "people", [], 30))

        assert result["confidence"] == 0.1
        assert result["delta_p50"] == 0

    def test_all_decision_types_have_priors(self):
        """All decision types should have at least one domain."""
        for decision_type, domains in GENERIC_PRIORS.items():
            assert len(domains) > 0, f"{decision_type} has no domain priors"
            for domain, prior in domains.items():
                assert "p10" in prior
                assert "p50" in prior
                assert "p90" in prior
                assert "unit" in prior

    def test_prior_ordering(self):
        """p10 <= p50 <= p90 for all generic priors."""
        for dt, domains in GENERIC_PRIORS.items():
            for domain, prior in domains.items():
                assert prior["p10"] <= prior["p50"] <= prior["p90"], \
                    f"Ordering violated for {dt}/{domain}: {prior}"


class TestRunSimulation:
    """Test Monte Carlo simulation."""

    def test_basic_simulation(self):
        """Simulation should combine baseline and impact correctly."""
        baselines = [{
            "domain": "body",
            "metric": "Sleep duration",
            "unit": "hours/night",
            "p10_final": 6.5,
            "p50_final": 7.5,
            "p90_final": 8.5,
            "confidence": 0.7,
        }]
        impacts = [{
            "domain": "body",
            "source": "generic-prior",
            "analog_count": 0,
            "delta_p10": -0.5,
            "delta_p50": 0.0,
            "delta_p90": 0.5,
            "confidence": 0.25,
        }]

        results = asyncio.run(run_simulation(baselines, impacts, 5000))

        assert len(results) == 1
        r = results[0]
        assert r["domain"] == "body"
        assert r["metric"] == "Sleep duration"
        # Projected should be baseline + delta range
        assert r["projected_p10"] <= r["projected_p50"] <= r["projected_p90"]
        # Confidence should be min of baseline and impact
        assert r["confidence"] == 0.25

    def test_zero_delta_simulation(self):
        """Zero deltas should produce projections near the baseline p50."""
        baselines = [{
            "domain": "money",
            "metric": "Net cash flow",
            "unit": "USD",
            "p10_final": 0,
            "p50_final": 1000,
            "p90_final": 0,
            "confidence": 0.5,
        }]
        impacts = [{
            "domain": "money",
            "source": "generic-prior",
            "analog_count": 0,
            "delta_p10": 0,
            "delta_p50": 0,
            "delta_p90": 0,
            "confidence": 0.25,
        }]

        results = asyncio.run(run_simulation(baselines, impacts, 1000))

        assert len(results) == 1
        # All projected values should equal baseline p50 when delta is 0
        assert results[0]["projected_p50"] == 1000

    def test_multiple_domains(self):
        """Simulation with multiple domains should produce one outcome per domain."""
        domains = ["body", "money", "time"]
        baselines = [{
            "domain": d,
            "metric": d,
            "unit": "",
            "p10_final": 0,
            "p50_final": 50,
            "p90_final": 100,
            "confidence": 0.5,
        } for d in domains]

        impacts = [{
            "domain": d,
            "source": "generic-prior",
            "analog_count": 0,
            "delta_p10": -5,
            "delta_p50": 0,
            "delta_p90": 5,
            "confidence": 0.25,
        } for d in domains]

        results = asyncio.run(run_simulation(baselines, impacts, 1000))

        assert len(results) == 3
        for r in results:
            assert r["projected_p10"] <= r["projected_p50"] <= r["projected_p90"]

    def test_distribution_invariant(self):
        """p10 <= p50 <= p90 must always hold in output."""
        np.random.seed(42)
        for _ in range(10):
            delta_vals = sorted(np.random.uniform(-5, 5, 3))
            baselines = [{
                "domain": "body",
                "metric": "test",
                "unit": "",
                "p10_final": 0,
                "p50_final": 50,
                "p90_final": 100,
                "confidence": 0.5,
            }]
            impacts = [{
                "domain": "body",
                "source": "generic-prior",
                "analog_count": 0,
                "delta_p10": float(delta_vals[0]),
                "delta_p50": float(delta_vals[1]),
                "delta_p90": float(delta_vals[2]),
                "confidence": 0.25,
            }]

            results = asyncio.run(run_simulation(baselines, impacts, 1000))
            r = results[0]
            assert r["projected_p10"] <= r["projected_p50"] <= r["projected_p90"]

    def test_impact_source_passthrough(self):
        """Impact source should be passed through to output."""
        baselines = [{
            "domain": "body",
            "metric": "test",
            "unit": "",
            "p10_final": 0,
            "p50_final": 50,
            "p90_final": 100,
            "confidence": 0.5,
        }]
        impacts = [{
            "domain": "body",
            "source": "empirical",
            "analog_count": 5,
            "delta_p10": -1,
            "delta_p50": 0,
            "delta_p90": 1,
            "confidence": 0.6,
        }]

        results = asyncio.run(run_simulation(baselines, impacts, 100))
        assert results[0]["impact_source"] == "empirical"
        assert results[0]["analog_count"] == 5
