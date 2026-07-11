#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Side-effect-free helpers for dashboard janitor settings."""

import math


def resolve_auto_janitor_hours(value=None):
    """Return a finite positive interval, or 0 to keep auto janitor disabled."""
    if value is None:
        return 0
    if isinstance(value, str) and not value.strip():
        return 0
    try:
        hours = float(value)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(hours) or hours <= 0:
        return 0
    return hours


def resolve_auto_janitor_hours_from_keys(keys=None):
    if not isinstance(keys, dict) or "AUTO_JANITOR_HOURS" not in keys:
        return 0
    return resolve_auto_janitor_hours(keys.get("AUTO_JANITOR_HOURS"))
