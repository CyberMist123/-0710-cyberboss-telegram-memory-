#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path


KIT = Path(__file__).resolve().parent.parent
TEMP = Path(tempfile.mkdtemp(prefix="dashboard-writer-lease-"))
MEMORY = TEMP / "memory"
CONTINUITY = TEMP / "continuity"
STATE = TEMP / "state"
WORKSPACE = TEMP / "workspace"
for directory in (MEMORY, CONTINUITY, STATE, WORKSPACE):
    directory.mkdir(parents=True, exist_ok=True)

os.environ.update({
    "CYBERBOSS_DASHBOARD_KEYS_FILE": str(TEMP / "keys.local.json"),
    "CYBERBOSS_MEMORY_DIR": str(MEMORY),
    "CYBERBOSS_CONTINUITY_DIR": str(CONTINUITY),
    "CYBERBOSS_STATE_DIR": str(STATE),
    "CYBERBOSS_WORKSPACE_ROOT": str(WORKSPACE),
    "CYBERBOSS_PROJECT_ROOT": str(WORKSPACE),
})

sys.path.insert(0, str(KIT))
from writer_lease import (  # noqa: E402
    DASHBOARD_WRITER_LEASE_DETAILS,
    WriterLeaseIdentityMismatch,
    WriterLeaseUnavailable,
    acquire_memory_writer_lease,
    release_memory_writer_lease,
    MEMORY_WRITER_LEASE_BASENAME,
    resolve_memory_writer_lease_file,
)

spec = importlib.util.spec_from_file_location("dashboard_writer_lease_test", KIT / "dashboard.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


def test_protocol_shape_and_identity_checked_release():
    lease_file = resolve_memory_writer_lease_file(CONTINUITY, "")
    assert lease_file == (CONTINUITY / ".jobs" / "MEMORY_WRITER_LEASE.json").resolve()
    lease = acquire_memory_writer_lease(lease_file)
    stored = json.loads(lease_file.read_text(encoding="utf-8"))
    assert stored == lease
    assert stored["schema_version"] == 1
    assert stored["owner_pid"] > 0
    assert set(DASHBOARD_WRITER_LEASE_DETAILS) == {
        "writer", "model", "phase", "branch", "worktree", "base_sha"
    }
    assert all(isinstance(value, str) and value for value in DASHBOARD_WRITER_LEASE_DETAILS.values())

    try:
        acquire_memory_writer_lease(lease_file)
        raise AssertionError("exclusive acquisition unexpectedly succeeded")
    except WriterLeaseUnavailable:
        pass

    try:
        release_memory_writer_lease(lease_file, "00000000-0000-4000-8000-000000000000")
        raise AssertionError("mismatched lease id unexpectedly released")
    except WriterLeaseIdentityMismatch:
        pass
    assert lease_file.is_file()
    assert lease_file.read_bytes() == json.dumps(stored, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    release_memory_writer_lease(lease_file, lease["lease_id"])
    assert not lease_file.exists()


def test_reentry_write_failure_releases_lease():
    reentry = MEMORY / "reentry.md"
    reentry.write_text("Obviously fake handoff before failure.\n", encoding="utf-8")
    original = dashboard.write_text_atomic

    def fail_reentry_write(path, content):
        if Path(path).resolve() == reentry.resolve():
            raise OSError("fixture body write failure")
        return original(path, content)

    dashboard.write_text_atomic = fail_reentry_write
    try:
        try:
            dashboard.save_context_source("reentry", "Obviously fake replacement.\n", source="fixture")
            raise AssertionError("body write unexpectedly succeeded")
        except OSError as error:
            assert str(error) == "fixture body write failure"
    finally:
        dashboard.write_text_atomic = original
    assert reentry.read_text(encoding="utf-8") == "Obviously fake handoff before failure.\n"
    assert not dashboard.WRITER_LEASE_FILE.exists()


def test_non_reentry_path_is_unchanged_and_frozen_set_stays_seven():
    held = acquire_memory_writer_lease(dashboard.WRITER_LEASE_FILE)
    try:
        payload = dashboard.save_context_source(
            "current_state", "Obviously fake live state.", source="fixture"
        )
        assert any(row["key"] == "current_state" for row in payload["sources"])
        assert (STATE / "context-current-state.md").read_text(encoding="utf-8") == "Obviously fake live state."
        assert dashboard.WRITER_LEASE_FILE.is_file()
    finally:
        release_memory_writer_lease(dashboard.WRITER_LEASE_FILE, held["lease_id"])
    assert len(dashboard.FROZEN_WRITE_ENDPOINTS) == 7


def test_no_python_recovery_or_process_liveness_implementation():
    source = (KIT / "writer_lease.py").read_text(encoding="utf-8")
    for forbidden in ("os.kill", "OpenProcess", "psutil", "os.path.exists"):
        assert forbidden not in source


def test_lease_path_resolution_is_lexical_not_filesystem_canonical():
    """Pin the resolution semantics that make the cross-language lock a lock.

    Node's `path.resolve` is purely lexical. If this side ever goes back to
    `Path(...).resolve()`, Windows canonicalisation (8.3 short names, junctions,
    symlinks) makes the two languages compute *different* lease path strings, and
    it does so silently. CI caught exactly this on 2026-08-02, where the runner's
    temp directory carried an 8.3 short component that one side expanded and the
    other did not. The assertion below is environment-independent on purpose: it
    compares against os.path.abspath rather than against a fixture path, because a
    dev box with no 8.3 / junction components makes both implementations agree.
    """
    messy = os.path.join(tempfile.gettempdir(), "a", "..", "b", ".jobs", "x.json")
    got = resolve_memory_writer_lease_file("", writer_lease_file=messy)
    assert str(got) == os.path.abspath(messy), (str(got), os.path.abspath(messy))

    # Environment-independent guard: the equality above only diverges where the
    # filesystem has 8.3 names / junctions / symlinks, so it silently passes on a
    # clean dev box. Assert the semantics at the source level instead.
    source = (KIT / "writer_lease.py").read_text(encoding="utf-8")
    code = [
        line for line in source.splitlines()
        if not line.lstrip().startswith("#") and "Do NOT use" not in line
    ]
    code = chr(10).join(code)
    assert ".resolve()" not in code, "writer_lease.py must stay lexical; .resolve() reintroduces the split-lock bug"

    directory = os.path.join(tempfile.gettempdir(), "cont", "..", "cont2")
    got_default = resolve_memory_writer_lease_file(directory)
    expected_default = os.path.abspath(
        os.path.join(directory, ".jobs", MEMORY_WRITER_LEASE_BASENAME)
    )
    assert str(got_default) == expected_default, (str(got_default), expected_default)


def main():
    tests = [
        test_protocol_shape_and_identity_checked_release,
        test_reentry_write_failure_releases_lease,
        test_non_reentry_path_is_unchanged_and_frozen_set_stays_seven,
        test_no_python_recovery_or_process_liveness_implementation,
        test_lease_path_resolution_is_lexical_not_filesystem_canonical,
    ]
    for case in tests:
        case()
    print(f"dashboard shared writer lease: {len(tests)} tests passed")


if __name__ == "__main__":
    main()
