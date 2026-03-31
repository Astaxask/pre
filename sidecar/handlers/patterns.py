"""Pattern detection handler — cross-domain correlations, trend changes, anomalies."""

import sys
from collections import defaultdict
from datetime import datetime, timedelta
import numpy as np
from scipy import stats


def _events_to_daily_series(events: list[dict], domain: str, metric_key: str) -> dict[str, float]:
    """Aggregate events into daily values for a specific domain and metric."""
    daily: dict[str, list[float]] = defaultdict(list)

    for e in events:
        if e.get("domain") != domain:
            continue
        val = e.get(metric_key)
        if val is None:
            continue
        try:
            val = float(val)
        except (ValueError, TypeError):
            continue
        ts = e.get("timestamp", 0)
        day = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
        daily[day].append(val)

    return {day: np.mean(vals) for day, vals in daily.items()}


def _get_primary_metric(domain: str) -> str | None:
    """Return the primary metric key for pattern detection."""
    return {
        "body": "sleepDurationHours",
        "money": "amount",
        "time": "durationMinutes",
        "people": "communicationCount",
        "mind": "progressPercent",
    }.get(domain)


def _daily_series_to_arrays(series: dict[str, float], days: int = 14) -> tuple[list[str], list[float]]:
    """Get the last N days sorted by date."""
    sorted_days = sorted(series.keys())[-days:]
    return sorted_days, [series[d] for d in sorted_days]


async def detect_patterns(events: list[dict]) -> list[dict]:
    """Detect cross-domain patterns in event data.

    Runs three algorithms:
    a) Cross-domain correlation
    b) Trend change detection
    c) Anomaly detection
    """
    patterns: list[dict] = []

    # Build per-domain daily series
    domains = ["body", "money", "time", "people", "mind"]
    domain_series: dict[str, dict[str, float]] = {}

    for domain in domains:
        metric = _get_primary_metric(domain)
        if metric is None:
            continue

        if domain == "money":
            # Special: compute daily net cash flow
            daily_flow: dict[str, float] = defaultdict(float)
            for e in events:
                if e.get("domain") != "money":
                    continue
                amount = e.get("amount")
                if amount is None:
                    continue
                try:
                    amount = float(amount)
                except (ValueError, TypeError):
                    continue
                direction = e.get("direction", "debit")
                ts = e.get("timestamp", 0)
                day = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
                if direction == "credit":
                    daily_flow[day] += amount
                else:
                    daily_flow[day] -= amount
            domain_series["money"] = dict(daily_flow)
        else:
            series = _events_to_daily_series(events, domain, metric)
            if series:
                domain_series[domain] = series

    # a) Cross-domain correlation
    domain_names = list(domain_series.keys())
    for i in range(len(domain_names)):
        for j in range(i + 1, len(domain_names)):
            d1, d2 = domain_names[i], domain_names[j]
            s1, s2 = domain_series[d1], domain_series[d2]

            # Find overlapping days
            common_days = sorted(set(s1.keys()) & set(s2.keys()))
            if len(common_days) < 10:
                continue

            vals1 = [s1[d] for d in common_days]
            vals2 = [s2[d] for d in common_days]

            r, p_value = stats.pearsonr(vals1, vals2)

            if abs(r) > 0.65 and p_value < 0.05:
                direction = "positive" if r > 0 else "negative"
                patterns.append({
                    "type": "correlation",
                    "domains": [d1, d2],
                    "confidence": min(0.95, abs(r)),
                    "metadata": {
                        "r_value": float(r),
                        "p_value": float(p_value),
                        "direction": direction,
                        "data_points": len(common_days),
                    },
                })

    # b) Trend change detection
    for domain, series in domain_series.items():
        sorted_days = sorted(series.keys())
        if len(sorted_days) < 14:
            continue

        # Last 14 days vs previous 14 days
        recent = sorted_days[-14:]
        previous = sorted_days[-28:-14] if len(sorted_days) >= 28 else sorted_days[:-14]

        if len(previous) < 7:
            continue

        recent_vals = [series[d] for d in recent]
        prev_vals = [series[d] for d in previous]

        # Linear regression slopes
        recent_slope = stats.linregress(range(len(recent_vals)), recent_vals).slope
        prev_slope = stats.linregress(range(len(prev_vals)), prev_vals).slope

        # Check if slope changed significantly
        all_vals = prev_vals + recent_vals
        std = np.std(all_vals) if len(all_vals) > 1 else 1.0
        if std == 0:
            continue

        slope_change = recent_slope - prev_slope
        if abs(slope_change) > std:
            direction = "improving" if slope_change > 0 else "declining"
            patterns.append({
                "type": "trend-change",
                "domains": [domain],
                "confidence": min(0.9, abs(slope_change) / std * 0.5),
                "metadata": {
                    "direction": direction,
                    "slope_change": float(slope_change),
                    "recent_slope": float(recent_slope),
                    "previous_slope": float(prev_slope),
                },
            })

    # c) Anomaly detection
    for domain, series in domain_series.items():
        sorted_days = sorted(series.keys())
        if len(sorted_days) < 10:
            continue

        all_vals = [series[d] for d in sorted_days]
        rolling_mean = np.mean(all_vals)
        rolling_std = np.std(all_vals)

        if rolling_std == 0:
            continue

        # Last 3 days
        last_3 = sorted_days[-3:]
        last_3_mean = np.mean([series[d] for d in last_3])

        z_score = (last_3_mean - rolling_mean) / rolling_std
        if abs(z_score) > 2.0:
            direction = "increasing" if z_score > 0 else "declining"
            patterns.append({
                "type": "anomaly",
                "domains": [domain],
                "confidence": min(0.9, abs(z_score) / 3.0),
                "metadata": {
                    "direction": direction,
                    "z_score": float(z_score),
                    "rolling_mean": float(rolling_mean),
                    "last_3_mean": float(last_3_mean),
                },
            })

    return patterns
