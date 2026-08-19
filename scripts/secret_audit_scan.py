#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path, PurePosixPath

SECRET_PATTERNS = [
    ("openai_or_anthropic_key", re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("telegram_bot_token", re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b")),
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
]

CREDENTIAL_IN_URL_PATTERN = re.compile(r"https?://[^/\s:@]+:([^@\s/]+)@")
CI_PLACEHOLDER_PATTERNS = (
    re.compile(r"^\$\{[A-Z0-9_]+\}$"),
    re.compile(r"^\$[A-Z0-9_]+$"),
    re.compile(r"^%[A-Z0-9_]+%$"),
    re.compile(r"^\$\{\{\s*(?:env\.)?[A-Z0-9_]+\s*\}\}$"),
)

GENERIC_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret(?:[_-]?key)?|"
    r"password|passwd|telegram[_-]?bot[_-]?token)\b\s*[:=]\s*[\"']?"
    r"([A-Za-z0-9_./+=:@-]{16,})"
)

# Blob-level exemptions, keyed by FULL object sha. Each entry must be a blob
# whose flagged content is a documented, intentionally fake value that was never
# a real credential. This list only silences those exact historical bytes:
# any new commit -- even re-adding the same fake -- produces a different blob
# only if content changes, so keep current trees free of pattern-matching fakes
# instead of growing this list.
ALLOWED_FAKE_BLOBS = {
    # test/claude-g3-preflight.test.js as merged by PR #109 (commit 6fce0c8).
    # Contained `const secret = "sk-fake..."` -- a hardcoded non-disclosure
    # canary in an offline test, never a real key. Defused in the current tree
    # (renamed to plantedValue with a non-key-shaped value); the old blob stays
    # reachable in history because main forbids history rewrites.
    "ca55a87958b9a9307f3c8ab332d2dae48587d14a",
    # src/services/cmx-image-recognizer.js as committed by local WIP be1f193
    # (batch/lookup-uncap, unpushed). Flagged line 36 is `apiKey:
    # config.visionQwenApiKey,` -- a 37-byte config *reference*, no literal
    # credential (verified 2026-08-09 while it blocked an unrelated push via
    # rev-list --all). The pattern itself must still be renamed on that branch
    # before its own push: any edit to the file produces a new blob and trips
    # the gate again, which is intended.
    "64ce076198cc85670dab69b318df17741cb60fda",
}

PLACEHOLDER_MARKERS = (
    "example",
    "changeme",
    "placeholder",
    "your_",
    "dummy",
    "test_token",
    "test-key",
    "fake_offline_token",
    "fakefake",
    "config.",
    "must-not-be-stored",
    "never-print-this",
    "crypto.randombytes",
    "xxxxx",
    "redacted",
    "process.env",
    "os.getenv",
    "localhost",
    "127.0.0.1",
)


def run(*args: str, input_text: str | None = None) -> str:
    result = subprocess.run(
        args,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return result.stdout


def is_ci_placeholder_credential(value: str) -> bool:
    normalized = value.strip()
    return any(pattern.fullmatch(normalized) for pattern in CI_PLACEHOLDER_PATTERNS)


def credential_in_url_result(url: str) -> tuple[str, str]:
    match = CREDENTIAL_IN_URL_PATTERN.search(url)
    if not match:
        return "clean", "no credential-in-url pattern matched"
    credential = match.group(1)
    if is_ci_placeholder_credential(credential):
        return "allowed", "placeholder credential is intentionally ignored"
    return "blocked", "credential_in_url detected"


def scan_repository(push_tips: list[str] | None = None) -> int:
    # Two scopes, one scanner:
    # - Full scan (no tips): every object reachable from any ref. CI's post-push
    #   backstop (secret-audit.yml) runs this; it is the safety net that keeps
    #   the incremental mode honest.
    # - Incremental scan (--push-tip, from .githooks/pre-push): only objects
    #   reachable from the tips being pushed that origin does not already have.
    #   Anything reachable from a remote-tracking ref is already public -- on a
    #   public repository re-scanning it on every push buys nothing (D51).
    if push_tips:
        object_rows = run(
            "git", "rev-list", "--objects", *push_tips, "--not", "--remotes=origin"
        ).splitlines()
    else:
        object_rows = run("git", "rev-list", "--objects", "--all").splitlines()
    paths_by_sha: dict[str, set[str]] = defaultdict(set)
    shas: list[str] = []
    for row in object_rows:
        sha, *rest = row.split(" ", 1)
        shas.append(sha)
        if rest and rest[0]:
            paths_by_sha[sha].add(rest[0])

    if shas:
        batch_input = "\n".join(dict.fromkeys(shas)) + "\n"
        object_info = run(
            "git",
            "cat-file",
            "--batch-check=%(objectname) %(objecttype) %(objectsize)",
            input_text=batch_input,
        ).splitlines()
    else:
        # Incremental scope can legitimately be empty (everything being pushed
        # is already on origin). An empty batch line would make cat-file report
        # a bogus "missing" object, so short-circuit instead.
        object_info = []

    suspicious_names: set[str] = set()
    findings: set[tuple[str, str, int, str]] = set()
    max_blob_size = 2_000_000

    for info in object_info:
        sha, object_type, size_text = info.split(" ", 2)
        if object_type != "blob" or int(size_text) > max_blob_size:
            continue
        if sha in ALLOWED_FAKE_BLOBS:
            continue

        paths = paths_by_sha.get(sha) or {"<historical-blob>"}
        for path in paths:
            p = PurePosixPath(path)
            name = p.name.lower()
            if (
                (name == ".env" or (name.startswith(".env.") and name != ".env.example"))
                or name in {"id_rsa", "id_ed25519", "credentials.json", "service-account.json", "keys.json"}
                or p.suffix.lower() in {".pem", ".p12", ".pfx"}
            ):
                suspicious_names.add(path)

        raw = subprocess.run(
            ["git", "cat-file", "blob", sha],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        ).stdout
        if b"\x00" in raw:
            continue
        text = raw.decode("utf-8", errors="ignore")

        for detector, pattern in SECRET_PATTERNS:
            for match in pattern.finditer(text):
                # 与 generic_secret_assignment 同一套白名单：占位符/测试假 key
                # （sk-fakefake…）与变量引用（config.xxx）不算真凭据。
                value = match.group(0).lower()
                if any(marker in value for marker in PLACEHOLDER_MARKERS):
                    continue
                line_no = text.count("\n", 0, match.start()) + 1
                for path in paths:
                    findings.add((path, detector, line_no, sha))

        for match in CREDENTIAL_IN_URL_PATTERN.finditer(text):
            credential = match.group(1)
            if is_ci_placeholder_credential(credential):
                continue
            line_no = text.count("\n", 0, match.start()) + 1
            for path in paths:
                findings.add((path, "credential_in_url", line_no, sha))

        for match in GENERIC_ASSIGNMENT.finditer(text):
            value = match.group(2).lower()
            if any(marker in value for marker in PLACEHOLDER_MARKERS):
                continue
            line_no = text.count("\n", 0, match.start()) + 1
            for path in paths:
                findings.add((path, "generic_secret_assignment", line_no, sha))

    report = {
        "secret_values_included": False,
        "reachable_objects_scanned": len(object_info),
        "suspicious_filenames": sorted(suspicious_names),
        "findings": [
            {"path": path, "detector": detector, "line": line_no, "blob": blob}
            for path, detector, line_no, blob in sorted(findings)
        ],
        "finding_count": len(suspicious_names) + len(findings),
    }
    Path("secret-audit-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    for path in sorted(suspicious_names):
        print(f"::error file={path}::suspicious credential-bearing filename is reachable in Git history")

    for path, detector, line_no, blob in sorted(findings):
        print(f"::error file={path},line={line_no}::{detector} detected in reachable blob {blob[:12]}; value intentionally suppressed")

    count = report["finding_count"]
    if count:
        print(f"Secret audit found {count} item(s). No secret values were printed or written to the report.")
        return 1

    print("Secret audit passed: no matching credentials or credential-bearing filenames found in reachable Git history.")
    return 0


def check_urls(urls: list[str]) -> int:
    exit_code = 0
    for url in urls:
        status, reason = credential_in_url_result(url)
        print(f"{status.upper()} {reason}: {url}")
        if status == "blocked":
            exit_code = 1
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the public readiness secret audit scanner.")
    parser.add_argument("--check-url", action="append", default=[], help="Check one or more credential-in-url samples.")
    parser.add_argument(
        "--push-tip",
        action="append",
        default=[],
        metavar="SHA",
        help="Scan only objects reachable from this commit that origin does not already have. Repeatable; used by .githooks/pre-push.",
    )
    args = parser.parse_args()

    if args.check_url:
        return check_urls(args.check_url)
    return scan_repository(args.push_tip)


if __name__ == "__main__":
    raise SystemExit(main())
