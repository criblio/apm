#!/bin/bash
#
# Manage the local Cribl MCP Server docker container.
#
# The Cribl MCP Server exposes Cribl Search / Cribl Stream to MCP clients
# (e.g. Claude Code) via an HTTP-only streamable transport on port 3030.
# Claude Code talks to it via the `mcp-remote` bridge configured in .mcp.json.
#
# Usage:
#   scripts/cribl-mcp.sh start   # pull image if needed, start container
#   scripts/cribl-mcp.sh stop    # stop + remove container
#   scripts/cribl-mcp.sh restart
#   scripts/cribl-mcp.sh status
#   scripts/cribl-mcp.sh logs    # follow container logs
#
# Requires .env with CRIBL_BASE_URL, CRIBL_CLIENT_ID, CRIBL_CLIENT_SECRET.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
CONTAINER_NAME="cribl-mcp-server"
IMAGE="cribl/cribl-mcp-server"
HOST_PORT="3030"

require_env() {
    if [ ! -f "$ENV_FILE" ]; then
        echo "❌ .env file not found at $ENV_FILE"
        echo "   Copy .env.example to .env and fill in CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET."
        exit 1
    fi
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a

    local missing=0
    for var in CRIBL_BASE_URL CRIBL_CLIENT_ID CRIBL_CLIENT_SECRET; do
        if [ -z "${!var:-}" ]; then
            echo "❌ $var is not set in $ENV_FILE"
            missing=1
        fi
    done
    [ "$missing" -eq 0 ] || exit 1
}

cmd_start() {
    require_env

    if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
        echo "ℹ️  $CONTAINER_NAME is already running"
        return 0
    fi

    # Remove any stopped container with the same name
    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
        docker rm "$CONTAINER_NAME" >/dev/null
    fi

    echo "🚀 Starting $CONTAINER_NAME on 127.0.0.1:$HOST_PORT ..."

    local -a env_args=(
        -e "CRIBL_BASE_URL=$CRIBL_BASE_URL"
        -e "CRIBL_CLIENT_ID=$CRIBL_CLIENT_ID"
        -e "CRIBL_CLIENT_SECRET=$CRIBL_CLIENT_SECRET"
    )
    if [ -n "${CRIBL_MCP_API_KEY:-}" ]; then
        env_args+=(-e "MCP_API_KEY=$CRIBL_MCP_API_KEY")
    fi

    docker run -d \
        --name "$CONTAINER_NAME" \
        --restart unless-stopped \
        -p "127.0.0.1:$HOST_PORT:3030" \
        "${env_args[@]}" \
        "$IMAGE" >/dev/null

    # Give it a moment to come up
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if curl -fsS "http://127.0.0.1:$HOST_PORT/health" >/dev/null 2>&1 \
           || curl -fsS "http://127.0.0.1:$HOST_PORT/mcp" >/dev/null 2>&1; then
            echo "✅ $CONTAINER_NAME is responding on 127.0.0.1:$HOST_PORT"
            return 0
        fi
        sleep 1
    done
    echo "⚠️  Container started but no response on port $HOST_PORT after 10s"
    echo "    Check logs with: scripts/cribl-mcp.sh logs"
    return 1
}

cmd_stop() {
    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
        docker rm -f "$CONTAINER_NAME" >/dev/null
        echo "🛑 Stopped $CONTAINER_NAME"
    else
        echo "ℹ️  $CONTAINER_NAME is not running"
    fi
}

cmd_status() {
    if docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E "^$CONTAINER_NAME\b"; then
        return 0
    fi
    echo "$CONTAINER_NAME is not running"
    return 1
}

cmd_logs() {
    exec docker logs -f "$CONTAINER_NAME"
}

case "${1:-}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_stop; cmd_start ;;
    status)  cmd_status ;;
    logs)    cmd_logs ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}" >&2
        exit 2
        ;;
esac
