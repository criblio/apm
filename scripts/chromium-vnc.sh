#!/bin/bash
#
# Launch (or relaunch) the VNC Chromium with the CDP debug port exposed.
#
# The VNC session runs on DISPLAY=:1 under `clint`'s gnome-shell, and Chromium
# is installed as a Flatpak (`org.chromium.Chromium`). Launching from a plain
# SSH shell fails silently unless we borrow the session's DBus env — the
# DBUS_SESSION_BUS_ADDRESS is ephemeral per VNC login, so we read it fresh
# from the running gnome-shell process each time.
#
# Usage:
#   scripts/chromium-vnc.sh start     # launch Chromium with CDP on 127.0.0.1:9222
#   scripts/chromium-vnc.sh restart   # kill + relaunch
#   scripts/chromium-vnc.sh status    # is the CDP port listening?
#   scripts/chromium-vnc.sh stop      # kill the running Chromium

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
CDP_ADDR="${CDP_ADDR:-127.0.0.1}"
LOG_FILE="${CHROMIUM_VNC_LOG:-/tmp/chromium-vnc.log}"

import_vnc_env() {
    local pid
    pid="$(pgrep -u "${USER:-clint}" -x gnome-shell | head -1)"
    if [ -z "$pid" ]; then
        echo "❌ gnome-shell not running — is the VNC session up?" >&2
        exit 1
    fi
    # Extract only the env vars we need; /proc/PID/environ is NUL-separated
    eval "$(tr '\0' '\n' < "/proc/$pid/environ" \
        | grep -E '^(DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_DATA_DIRS|XDG_RUNTIME_DIR)=' \
        | sed 's/^/export /')"
}

cdp_listening() {
    ss -tln 2>/dev/null | awk '{print $4}' | grep -q ":$CDP_PORT\$"
}

cmd_status() {
    if cdp_listening; then
        echo "✅ CDP listening on $CDP_ADDR:$CDP_PORT"
        if command -v curl >/dev/null 2>&1; then
            curl -fsS "http://$CDP_ADDR:$CDP_PORT/json/version" \
                | grep -E '"Browser"|"Protocol-Version"' || true
        fi
        return 0
    fi
    echo "❌ CDP not listening on $CDP_ADDR:$CDP_PORT"
    return 1
}

cmd_stop() {
    # Match the real Chromium main process — avoid killing the bash wrapper
    # or zygote helpers. Inside the Flatpak sandbox the main binary is
    # /app/chromium/chrome.
    if pkill -TERM -f '/app/chromium/chrome --enable-features' 2>/dev/null; then
        echo "🛑 Sent SIGTERM to Chromium"
        sleep 2
    else
        echo "ℹ️  No running Chromium found"
    fi
}

cmd_start() {
    if cdp_listening; then
        echo "ℹ️  CDP already listening on $CDP_ADDR:$CDP_PORT — nothing to do"
        return 0
    fi

    import_vnc_env

    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
        echo "❌ DBUS_SESSION_BUS_ADDRESS not found in gnome-shell env" >&2
        exit 1
    fi

    echo "🚀 Launching Chromium (DISPLAY=$DISPLAY)"
    nohup flatpak run org.chromium.Chromium \
        --remote-debugging-port="$CDP_PORT" \
        --remote-debugging-address="$CDP_ADDR" \
        >"$LOG_FILE" 2>&1 &
    disown

    # Wait up to 10s for the debug port to come up
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if cdp_listening; then
            echo "✅ CDP listening on $CDP_ADDR:$CDP_PORT"
            if command -v curl >/dev/null 2>&1; then
                curl -fsS "http://$CDP_ADDR:$CDP_PORT/json/version" \
                    | grep -E '"Browser"|"Protocol-Version"' || true
            fi
            echo "   log: $LOG_FILE"
            return 0
        fi
        sleep 1
    done

    echo "⚠️  Chromium started but no listener on $CDP_PORT after 10s"
    echo "    Check log: $LOG_FILE"
    return 1
}

cmd_restart() {
    cmd_stop
    cmd_start
}

case "${1:-start}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}" >&2
        exit 2
        ;;
esac
