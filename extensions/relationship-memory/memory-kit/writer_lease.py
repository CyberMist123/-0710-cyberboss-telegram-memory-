"""Cross-language memory writer lease shared with the Node continuity writers."""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path


MEMORY_WRITER_LEASE_BASENAME = "MEMORY_WRITER_LEASE.json"

# The dashboard is a long-running control plane, not an engineering worktree.
# These stable protocol identities describe that role; the VCS-shaped fields use
# an explicit non-claim instead of inventing per-request branch or SHA values.
DASHBOARD_WRITER_LEASE_DETAILS = {
    "writer": "520-dashboard",
    "model": "not-applicable",
    "phase": "reentry-save",
    "branch": "not-applicable",
    "worktree": "not-applicable",
    "base_sha": "not-applicable",
}


class WriterLeaseUnavailable(RuntimeError):
    """The shared lease is already held; dashboard writes must fail closed."""


class WriterLeaseIdentityMismatch(RuntimeError):
    """The stored lease is no longer the lease this caller acquired."""


def resolve_memory_writer_lease_file(continuity_dir, writer_lease_file=None):
    """Mirror Node resolveMemoryWriterLeaseFile with the same absolute path rule."""
    configured = (
        os.environ.get("CYBERBOSS_WRITER_LEASE_FILE", "")
        if writer_lease_file is None
        else str(writer_lease_file)
    ).strip()
    if configured:
        return Path(configured).resolve()
    directory = str(continuity_dir or "").strip()
    if not directory:
        return None
    return (Path(directory) / ".jobs" / MEMORY_WRITER_LEASE_BASENAME).resolve()


def acquire_memory_writer_lease(file_path):
    """Acquire exclusively; Python intentionally has no recovery authority."""
    destination = Path(file_path).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    lease = {
        "schema_version": 1,
        "lease_id": str(uuid.uuid4()),
        "owner_pid": os.getpid(),
        "acquired_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        **DASHBOARD_WRITER_LEASE_DETAILS,
    }
    try:
        descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise WriterLeaseUnavailable(f"Writer lease already held: {destination}") from error
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(lease, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    return lease


def release_memory_writer_lease(file_path, lease_id):
    """Release only the exact lease acquired by this caller."""
    destination = Path(file_path).resolve()
    current = json.loads(destination.read_text(encoding="utf-8"))
    if not lease_id or current.get("lease_id") != lease_id:
        raise WriterLeaseIdentityMismatch("Writer lease identity mismatch; refusing release")
    destination.unlink()
