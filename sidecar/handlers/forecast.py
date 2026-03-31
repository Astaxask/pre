"""Forecasting and simulation handlers — Prophet baselines, impact estimation, Monte Carlo."""

import sys
from collections import defaultdict
from datetime import datetime
import numpy as np

# Prophet is optional — if not installed, forecast returns insufficient_data
try:
    from prophet import Prophet
    PROPHET_AVAILABLE = True
except ImportError:
    PROPHET_AVAILABLE = False
    print("[sidecar] Prophet not available — forecast_domain will return insufficient_data", file=sys.stderr)


DOMAIN_METRICS = {
    "body": {"metric": "Sleep duration", "unit": "hours/night"},
    "money": {"metric": "Monthly net cash flow", "unit": "USD"},
    "time": {"metric": "Weekly committed hours", "unit": "hours/week"},
    "people": {"metric": "Relationship engagement score", "unit": "0-100"},
    "mind": {"metric": "Goal progress velocity", "unit": "% per week"},
}

GENERIC_PRIORS = {
    "job-change": {
        "body": {"p10": -0.8, "p50": 0.0, "p90": 0.5, "unit": "hours_sleep_delta"},
        "money": {"p10": -0.15, "p50": 0.10, "p90": 0.35, "unit": "fraction_income_change"},
        "time": {"p10": -5, "p50": 2, "p90": 12, "unit": "hours_committed_per_week_delta"},
        "mind": {"p10": -15, "p50": 5, "p90": 25, "unit": "goal_progress_velocity_delta"},
        "people": {"p10": -20, "p50": -5, "p90": 10, "unit": "engagement_score_delta"},
    },
    "financial-major": {
        "money": {"p10": -0.30, "p50": -0.05, "p90": 0.15, "unit": "fraction_income_change"},
        "mind": {"p10": -10, "p50": 0, "p90": 15, "unit": "goal_progress_velocity_delta"},
        "body": {"p10": -0.3, "p50": 0.0, "p90": 0.2, "unit": "hours_sleep_delta"},
    },
    "habit-add": {
        "body": {"p10": 0.0, "p50": 0.3, "p90": 0.8, "unit": "hours_sleep_delta"},
        "time": {"p10": 2, "p50": 5, "p90": 10, "unit": "hours_committed_per_week_delta"},
        "mind": {"p10": -5, "p50": 10, "p90": 30, "unit": "goal_progress_velocity_delta"},
    },
    "habit-remove": {
        "body": {"p10": -0.5, "p50": 0.2, "p90": 0.6, "unit": "hours_sleep_delta"},
        "time": {"p10": -8, "p50": -3, "p90": 2, "unit": "hours_committed_per_week_delta"},
        "people": {"p10": -10, "p50": 0, "p90": 15, "unit": "engagement_score_delta"},
    },
    "relationship-change": {
        "people": {"p10": -30, "p50": 0, "p90": 25, "unit": "engagement_score_delta"},
        "time": {"p10": -5, "p50": 3, "p90": 10, "unit": "hours_committed_per_week_delta"},
        "body": {"p10": -0.5, "p50": 0.0, "p90": 0.3, "unit": "hours_sleep_delta"},
        "mind": {"p10": -20, "p50": 0, "p90": 20, "unit": "goal_progress_velocity_delta"},
        "money": {"p10": -0.10, "p50": 0.0, "p90": 0.05, "unit": "fraction_income_change"},
    },
    "location-change": {
        "time": {"p10": -10, "p50": 0, "p90": 5, "unit": "hours_committed_per_week_delta"},
        "money": {"p10": -0.20, "p50": -0.05, "p90": 0.10, "unit": "fraction_income_change"},
        "people": {"p10": -25, "p50": -10, "p90": 5, "unit": "engagement_score_delta"},
        "body": {"p10": -0.5, "p50": 0.0, "p90": 0.3, "unit": "hours_sleep_delta"},
    },
    "time-commitment": {
        "time": {"p10": 3, "p50": 8, "p90": 15, "unit": "hours_committed_per_week_delta"},
        "body": {"p10": -0.5, "p50": -0.2, "p90": 0.1, "unit": "hours_sleep_delta"},
        "mind": {"p10": -5, "p50": 5, "p90": 20, "unit": "goal_progress_velocity_delta"},
        "people": {"p10": -15, "p50": -5, "p90": 5, "unit": "engagement_score_delta"},
    },
    "health-intervention": {
        "body": {"p10": -0.3, "p50": 0.5, "p90": 1.5, "unit": "hours_sleep_delta"},
        "mind": {"p10": -10, "p50": 5, "p90": 25, "unit": "goal_progress_velocity_delta"},
        "time": {"p10": 1, "p50": 3, "p90": 8, "unit": "hours_committed_per_week_delta"},
        "money": {"p10": -0.10, "p50": -0.03, "p90": 0.0, "unit": "fraction_income_change"},
    },
}


async def forecast_domain(
    domain: str,
    events: list[dict],
    horizon_days: int = 30,
) -> dict:
    """Forecast a domain's primary metric forward using Prophet."""
    info = DOMAIN_METRICS.get(domain, {"metric": domain, "unit": ""})

    if len(events) < 14:
        return {
            "insufficient_data": True,
            "metric": info["metric"],
            "unit": info["unit"],
            "p10_final": 0,
            "p50_final": 0,
            "p90_final": 0,
            "confidence": 0,
        }

    if not PROPHET_AVAILABLE:
        # Fallback: simple statistics
        vals = [1.0] * len(events)  # placeholder
        return {
            "insufficient_data": True,
            "metric": info["metric"],
            "unit": info["unit"],
            "p10_final": 0,
            "p50_final": 0,
            "p90_final": 0,
            "confidence": 0,
        }

    # Extract daily values
    import pandas as pd
    daily: dict[str, list[float]] = defaultdict(list)
    for e in events:
        ts = e.get("timestamp", 0)
        day = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
        daily[day].append(1.0)  # Use event count as proxy metric

    df = pd.DataFrame([
        {"ds": pd.Timestamp(day), "y": np.mean(vals)}
        for day, vals in sorted(daily.items())
    ])

    if len(df) < 14:
        return {
            "insufficient_data": True,
            "metric": info["metric"],
            "unit": info["unit"],
            "p10_final": 0,
            "p50_final": 0,
            "p90_final": 0,
            "confidence": 0,
        }

    model = Prophet(
        daily_seasonality=len(df) >= 30,
        weekly_seasonality=len(df) >= 14,
        yearly_seasonality=len(df) >= 180,
        uncertainty_samples=1000,
    )
    model.fit(df)

    future = model.make_future_dataframe(periods=horizon_days)
    forecast = model.predict(future)

    tail = forecast.tail(horizon_days)
    p10 = float(tail["yhat_lower"].mean())
    p50 = float(tail["yhat"].mean())
    p90 = float(tail["yhat_upper"].mean())

    # Confidence: based on data volume
    confidence = min(0.9, 0.3 + len(df) / 180 * 0.6)

    return {
        "insufficient_data": False,
        "metric": info["metric"],
        "unit": info["unit"],
        "p10_final": p10,
        "p50_final": p50,
        "p90_final": p90,
        "confidence": confidence,
    }


async def estimate_impact(
    decision_type: str,
    domain: str,
    events: list[dict],
    horizon_days: int = 30,
) -> dict:
    """Estimate the impact of a decision on a domain."""
    priors = GENERIC_PRIORS.get(decision_type, {})
    prior = priors.get(domain)

    if prior is None:
        return {
            "source": "generic-prior",
            "analog_count": 0,
            "delta_p10": 0,
            "delta_p50": 0,
            "delta_p90": 0,
            "confidence": 0.1,
        }

    # For now, always use generic priors (analog search requires LanceDB embeddings)
    return {
        "source": "generic-prior",
        "analog_count": 0,
        "delta_p10": prior["p10"],
        "delta_p50": prior["p50"],
        "delta_p90": prior["p90"],
        "confidence": 0.25,
    }


async def run_simulation(
    baselines: list[dict],
    impacts: list[dict],
    n_samples: int = 1000,
) -> list[dict]:
    """Run Monte Carlo simulation combining baselines and impact estimates."""
    outcomes = []

    for baseline, impact in zip(baselines, impacts):
        domain = baseline.get("domain", "")
        metric = baseline.get("metric", "")
        unit = baseline.get("unit", "")
        b_p50 = float(baseline.get("p50_final", 0))
        b_p10 = float(baseline.get("p10_final", 0))
        b_p90 = float(baseline.get("p90_final", 0))

        d_p10 = float(impact.get("delta_p10", 0))
        d_p50 = float(impact.get("delta_p50", 0))
        d_p90 = float(impact.get("delta_p90", 0))

        # Ensure triangular distribution parameters are valid
        left = min(d_p10, d_p50, d_p90)
        mode = d_p50
        right = max(d_p10, d_p50, d_p90)

        if left == right:
            samples = [b_p50 + mode] * n_samples
        else:
            # Clamp mode within [left, right]
            mode = max(left, min(mode, right))
            deltas = np.random.triangular(left, mode, right, n_samples)
            samples = [b_p50 + d for d in deltas]

        proj_p10 = float(np.percentile(samples, 10))
        proj_p50 = float(np.percentile(samples, 50))
        proj_p90 = float(np.percentile(samples, 90))

        # Validate p10 <= p50 <= p90
        if not (proj_p10 <= proj_p50 <= proj_p90):
            raise ValueError(f"Distribution invariant violated for {domain}: p10={proj_p10}, p50={proj_p50}, p90={proj_p90}")

        b_confidence = float(baseline.get("confidence", 0))
        i_confidence = float(impact.get("confidence", 0))

        outcomes.append({
            "domain": domain,
            "metric": metric,
            "unit": unit,
            "baseline_p10": b_p10,
            "baseline_p50": b_p50,
            "baseline_p90": b_p90,
            "projected_p10": proj_p10,
            "projected_p50": proj_p50,
            "projected_p90": proj_p90,
            "confidence": min(b_confidence, i_confidence),
            "impact_source": impact.get("source", "generic-prior"),
            "analog_count": impact.get("analog_count", 0),
        })

    return outcomes
