#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${CYBERBOSS_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNTIME="${1:-}"
TOKEN="${GALATEA_GARDEN_MCP_TOKEN:-}"

if [[ "${RUNTIME}" != "codex" && "${RUNTIME}" != "claudecode" ]]; then
  echo "usage: $0 <codex|claudecode>" >&2
  exit 2
fi

if [[ -z "${TOKEN}" ]]; then
  echo "GALATEA_GARDEN_MCP_TOKEN is not set; refusing to embed a token in source." >&2
  exit 1
fi

cd "${ROOT_DIR}"
export GALATEA_GARDEN_MCP_TOKEN="${TOKEN}"
# This file is retained only as a sanitized upstream reference. Review before use.
echo "Sanitized baseline helper; configure your local runtime process manager explicitly." >&2
exit 1
