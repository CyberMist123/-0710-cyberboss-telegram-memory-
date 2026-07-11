#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from pathlib import Path
import sys
import unittest

KIT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT_DIR))

from janitor_config import resolve_auto_janitor_hours_from_keys  # noqa: E402


class DashboardJanitorConfigTests(unittest.TestCase):
    def test_missing_auto_janitor_hours_defaults_to_zero(self):
        self.assertEqual(resolve_auto_janitor_hours_from_keys({}), 0)
        self.assertEqual(resolve_auto_janitor_hours_from_keys(None), 0)

    def test_invalid_auto_janitor_hours_fail_closed_to_zero(self):
        for value in ["", "   ", "-1", "-0.5", "abc", "NaN", "Infinity", "-Infinity"]:
            with self.subTest(value=value):
                self.assertEqual(
                    resolve_auto_janitor_hours_from_keys({"AUTO_JANITOR_HOURS": value}),
                    0,
                )

    def test_only_finite_positive_auto_janitor_hours_enable_janitor(self):
        self.assertEqual(
            resolve_auto_janitor_hours_from_keys({"AUTO_JANITOR_HOURS": "0.25"}),
            0.25,
        )
        self.assertEqual(
            resolve_auto_janitor_hours_from_keys({"AUTO_JANITOR_HOURS": 6}),
            6,
        )


if __name__ == "__main__":
    unittest.main()
