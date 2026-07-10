#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/home/anan/cyberboss-deepseek"
STATE_DIR="/home/anan/.deepseek"
ENV_FILE="${STATE_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

export CYBERBOSS_STATE_DIR="${STATE_DIR}"
export CYBERBOSS_CHANNEL="${CYBERBOSS_CHANNEL:-telegram}"
export CYBERBOSS_RUNTIME="${CYBERBOSS_RUNTIME:-claudecode}"

cd "${ROOT_DIR}"
exec npm run doctor
