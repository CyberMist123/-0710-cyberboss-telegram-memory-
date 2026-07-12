#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${CYBERBOSS_REPO_ROOT:?Set CYBERBOSS_REPO_ROOT to the repository root.}"
STATE_DIR="${CYBERBOSS_STATE_DIR:?Set CYBERBOSS_STATE_DIR to the state directory.}"
CONFIG_DIR="${CYBERBOSS_CONFIG_DIR:-${STATE_DIR}}"
ENV_FILE="${CYBERBOSS_ENV_FILE:-${CONFIG_DIR}/.env}"

mkdir -p "${STATE_DIR}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

export CYBERBOSS_STATE_DIR="${STATE_DIR}"
export CYBERBOSS_CHANNEL="${CYBERBOSS_CHANNEL:-telegram}"
export CYBERBOSS_RUNTIME="${CYBERBOSS_RUNTIME:-claudecode}"

LOG_DIR="${CYBERBOSS_LOG_DIR:-${CYBERBOSS_STATE_DIR}/logs}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${CYBERBOSS_LOG_FILE:-${LOG_DIR}/cyberboss.log}"

cd "${ROOT_DIR}"
sleep 3
exec npm run start:checkin >> "${LOG_FILE}" 2>&1
