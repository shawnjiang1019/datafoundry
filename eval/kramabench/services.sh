#!/usr/bin/env bash
# Start, check or watch the three services a KramaBench run needs, for one domain:
#   DataLink (8080, the domain's graph), D-TRAIL (8061) and the DataFoundry API (8787, the domain's annotations).
#
#   services.sh start  <domain>   start whatever is down (restart DataLink if it serves another domain)
#   services.sh status <domain>   one line per service
#   services.sh watch  <domain>   check every WATCH_EVERY seconds (default 60) and restart a service
#                                 that fails two checks in a row; run it in the background during a run
#   services.sh stop              stop all three
#
# Logs go to $KRAMABENCH_DIR/eval_runs/services/. Secrets are read from the env files, never printed.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DF_ROOT=$(cd "$HERE/../.." && pwd)
INTEGRATION=$(cd "$DF_ROOT/.." && pwd)
K=${KRAMABENCH_DIR:-$(cd "$INTEGRATION/../tmp_DG/KramaBench" && pwd)}
G=$K/system_scratch/grounding
LOGS=$K/eval_runs/services
WATCH_EVERY=${WATCH_EVERY:-60}
mkdir -p "$LOGS"

cmd=${1:-}
domain=${2:-}

# Any HTTP answer means the server is up (the API answers 401 without a login, DataLink 404 on /).
up() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$1")" != "000" ]; }
api_up() { up http://127.0.0.1:8787/health; }
dtrail_up() { up http://127.0.0.1:8061/healthz; }
datalink_up() { up http://127.0.0.1:8080/; }
datalink_db() { ps -ax -o command | grep "datalink serve" | grep -v grep | grep -o -- "--db [^ ]*" | head -1 | cut -c6-; }
stamp() { date -u +%FT%TZ; }
# Stop whatever listens on a port: precise where process names are generic (the API runs as node dist/index.js).
free_port() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null; sleep 2; }

need_domain() {
  if [ -z "$domain" ]; then echo "usage: $0 $cmd <domain>" >&2; exit 2; fi
  [ -f "$G/datalink/$domain.db" ] || echo "warning: no DataLink graph at $G/datalink/$domain.db" >&2
  [ -f "$G/$domain-agent-annotation.json" ] || echo "warning: no annotations at $G/$domain-agent-annotation.json" >&2
}

start_datalink() {
  free_port 8080
  ( cd "$G/datalink" && set -a && . "$K/.df_eval.env" && set +a
    SSL_CERT_FILE=/etc/ssl/cert.pem nohup "$DF_ROOT/services/datalink/.venv/bin/datalink" serve \
      --transport streamable-http --host 127.0.0.1 --port 8080 --db "$G/datalink/$domain.db" \
      >> "$LOGS/datalink.log" 2>&1 < /dev/null & ) > /dev/null 2>&1
  echo "[$(stamp)] started DataLink ($domain)" | tee -a "$LOGS/watch.log"
}

start_dtrail() {
  free_port 8061
  ( cd "$INTEGRATION/d-trail" && set -a && . "$K/.df_eval.env" && set +a
    DTRAIL_API_KEY="$OPENAI_API_KEY" DTRAIL_MODEL_URL="$OPENAI_BASE_URL" DTRAIL_MODEL=glm-5.3-flash \
    DTRAIL_RESOLVER_MODEL=glm-5.3-flash DTRAIL_EXECUTION_BACKEND=local DTRAIL_DATALINK_URL=http://127.0.0.1:8080 \
    DTRAIL_MODEL_THINKING=off DTRAIL_MODEL_RETRY_TIMEOUTS=off \
    DTRAIL_WORKSPACE_ROOT="$G/dtrail_service/workspaces" SSL_CERT_FILE=/etc/ssl/cert.pem PYTHONPATH=src \
    nohup uvicorn dtrail_service.api:create_app --factory --host 127.0.0.1 --port 8061 \
      >> "$G/dtrail_service/service.log" 2>&1 < /dev/null & ) > /dev/null 2>&1
  echo "[$(stamp)] started D-TRAIL" | tee -a "$LOGS/watch.log"
}

start_api() {
  free_port 8787
  # The server alone is backgrounded (not a "cd && server" list, whose wrapper shell would wait on it
  # and hold the caller's output open), and no stream of the caller is passed down.
  ( cd "$DF_ROOT" || exit 1
    DF_MCP_TIMEOUT_MS=${DF_MCP_TIMEOUT_MS:-90000} \
    DF_ENV_ANNOTATION_PATH="$G/$domain-agent-annotation.json" DF_ENV_ANNOTATION_LAYERS=author_text,descriptions \
    DF_ENV_ANNOTATION_MAX_CHARS=12000 nohup npm --prefix apps/api run start >> "$LOGS/api-$domain.log" 2>&1 < /dev/null & ) > /dev/null 2>&1
  echo "[$(stamp)] started API ($domain)" | tee -a "$LOGS/watch.log"
}

wait_up() { for _ in $(seq 1 30); do "$1" && return 0; sleep 2; done; echo "[$(stamp)] $2 did not come up" | tee -a "$LOGS/watch.log"; return 1; }

status() {
  datalink_up && echo "DataLink  up   ($(datalink_db))" || echo "DataLink  DOWN"
  dtrail_up && echo "D-TRAIL   up" || echo "D-TRAIL   DOWN"
  api_up && echo "API       up" || echo "API       DOWN"
}

start_all() {
  # DataLink first (D-TRAIL reads it), and restart it when it serves another domain's graph.
  if ! datalink_up || [ "$(datalink_db)" != "$G/datalink/$domain.db" ]; then start_datalink; wait_up datalink_up DataLink; fi
  dtrail_up || { start_dtrail; wait_up dtrail_up D-TRAIL; }
  api_up || { start_api; wait_up api_up API; }
  status
}

watch_all() {
  local misses_datalink=0 misses_dtrail=0 misses_api=0
  echo "[$(stamp)] watching services for $domain every ${WATCH_EVERY}s" | tee -a "$LOGS/watch.log"
  while true; do
    if datalink_up; then misses_datalink=0; else misses_datalink=$((misses_datalink + 1)); fi
    if dtrail_up; then misses_dtrail=0; else misses_dtrail=$((misses_dtrail + 1)); fi
    if api_up; then misses_api=0; else misses_api=$((misses_api + 1)); fi
    # Two misses in a row: one can be a busy server between requests.
    if [ $misses_datalink -ge 2 ]; then echo "[$(stamp)] DataLink down" >> "$LOGS/watch.log"; start_datalink; wait_up datalink_up DataLink; misses_datalink=0; fi
    if [ $misses_dtrail -ge 2 ]; then echo "[$(stamp)] D-TRAIL down" >> "$LOGS/watch.log"; start_dtrail; wait_up dtrail_up D-TRAIL; misses_dtrail=0; fi
    if [ $misses_api -ge 2 ]; then echo "[$(stamp)] API down" >> "$LOGS/watch.log"; start_api; wait_up api_up API; misses_api=0; fi
    sleep "$WATCH_EVERY"
  done
}

case "$cmd" in
  start) need_domain; start_all ;;
  status) status ;;
  watch) need_domain; watch_all ;;
  stop)
    free_port 8080; free_port 8061; free_port 8787; status ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
