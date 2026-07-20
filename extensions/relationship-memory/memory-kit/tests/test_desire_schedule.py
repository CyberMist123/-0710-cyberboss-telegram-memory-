import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


def load_dashboard(tmp):
    state = Path(tmp) / "state"
    memory = Path(tmp) / "memory"
    project = Path(tmp) / "project"
    continuity = Path(tmp) / "continuity"
    for path in (state, memory, project, continuity):
        path.mkdir(parents=True, exist_ok=True)
    keys = state / "keys.json"
    keys.write_text(json.dumps({"API_TOKEN": "fixture-token"}), encoding="utf-8")
    os.environ.update({
        "CYBERBOSS_DASHBOARD_STATE_DIR": str(state),
        "CYBERBOSS_MEMORY_DIR": str(memory),
        "CYBERBOSS_PROJECT_ROOT": str(project),
        "CYBERBOSS_CONTINUITY_DIR": str(continuity),
        "CYBERBOSS_DASHBOARD_KEYS_FILE": str(keys),
    })
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    return importlib.import_module("dashboard")


class DesireScheduleTests(unittest.TestCase):
  def test_schedule_config_validation_backup_revision_and_dst(self):
    with tempfile.TemporaryDirectory() as tmp:
        dashboard = load_dashboard(tmp)
        cfg = dashboard.load_desire_schedule_config()
        assert cfg["interval_minutes"] == 55
        assert cfg["timezone"] == "Australia/Sydney"
        assert dashboard.validate_desire_schedule_body({"timezone": "Not/AZone"})[0] is False
        dashboard.DESIRE_SCHEDULE_FILE.write_text(json.dumps(cfg), encoding="utf-8")
        saved = dashboard.save_desire_schedule_config({
            "enabled": True,
            "interval_minutes": 55,
            "night_skip_enabled": True,
            "night_start": "23:00",
            "night_end": "06:00",
            "timezone": "Australia/Sydney",
        }, expected_revision=cfg["revision"])
        assert saved["revision"] != cfg["revision"]
        assert dashboard.DESIRE_SCHEDULE_FILE.exists()
        assert list(dashboard.DESIRE_SCHEDULE_BACKUP_DIR.iterdir())
        audit = dashboard.DESIRE_SCHEDULE_AUDIT_FILE.read_text(encoding="utf-8")
        assert "Australia/Sydney" in audit
        assert dashboard.desire_schedule_is_night(__import__("datetime").datetime(2026, 7, 20, 23, tzinfo=__import__("zoneinfo").ZoneInfo("Australia/Sydney")), saved)


  def test_schedule_time_payload_uses_actual_dst_offset(self):
    with tempfile.TemporaryDirectory() as tmp:
        dashboard = load_dashboard(tmp)
        cfg = dashboard.load_desire_schedule_config()
        payload = dashboard._schedule_now_payload({**cfg, "timezone": "Australia/Sydney"})
        self.assertEqual(payload["utc_now"][-1], "Z")
        self.assertTrue(payload["offset"].startswith("UTC"))


if __name__ == "__main__":
    unittest.main()
