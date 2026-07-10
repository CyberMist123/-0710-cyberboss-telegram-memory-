#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/home/anan/cyberboss-deepseek"
STATE_DIR="/home/anan/.deepseek"
ENV_FILE="${STATE_DIR}/.env"

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

mkdir -p "${CYBERBOSS_STATE_DIR}/logs"
LOG_FILE="${CYBERBOSS_STATE_DIR}/logs/cb-deepseek.log"

cd "${ROOT_DIR}"
sleep 3
exec npm run start:checkin >> "${LOG_FILE}" 2>&1
