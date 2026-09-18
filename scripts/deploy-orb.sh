#!/bin/sh
# Deploy the checked-out, committed fork revision. Does not silently git pull.
set -eu
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo 'Commit source changes before deployment so BUILD_COMMIT identifies the deployed source.' >&2
  exit 1
fi
python3 scripts/backup-instance.py
mkdir -p .local
chmod 700 .local
prior_image="$(docker --context orbstack compose images -q web | head -n 1)"
if [ -n "$prior_image" ]; then
  docker --context orbstack image tag "$prior_image" mediary-scout-web:rollback
  printf '%s\n' "$prior_image" > .local/rollback-image
fi
GIT_SHA="$(git rev-parse HEAD)"
export GIT_SHA
docker --context orbstack compose build web
docker --context orbstack compose up -d --no-deps --wait --wait-timeout 120 web
running="$(docker --context orbstack compose exec -T web cat BUILD_COMMIT)"
[ "$running" = "$GIT_SHA" ] || { echo 'Running image does not match checked-out commit' >&2; exit 1; }
docker --context orbstack compose exec -T web node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
printf 'Deployment verified: %s\n' "$running"
