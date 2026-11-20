#!/usr/bin/env bash
# Run on the existing server as root. Data, tokens and certificates stay in place.
set -euo pipefail
deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
service_name=ios-location-spoofer
vhost=/www/server/panel/vhost/nginx/gps.x-cipher.com.conf
action=${1:-status}

apply_vhost() {
    local backup
    backup=$(mktemp)
    cp -p "$vhost" "$backup"
    install -m 644 "$1" "$vhost"
    if ! nginx -t; then
        cp -p "$backup" "$vhost"
        rm -f "$backup"
        return 1
    fi
    if ! nginx -s reload; then
        cp -p "$backup" "$vhost"
        rm -f "$backup"
        return 1
    fi
    rm -f "$backup"
}

if [[ "$action" != status && "$EUID" -ne 0 ]]; then
    printf '%s\n' 'Run pause/resume as root.' >&2
    exit 1
fi

case "$action" in
    pause)
        systemctl disable --now "$service_name"
        apply_vhost "$deploy_dir/gps.x-cipher.com.paused.conf"
        printf '%s\n' 'Service stopped, startup disabled; data retained.'
        ;;
    resume)
        test -r /etc/ios-location-spoofer.env
        test -f /opt/ios-location-spoofer/current/server.mjs
        systemctl enable --now "$service_name"
        ready=false
        for attempt in {1..10}; do
            if curl -fsS --max-time 2 http://127.0.0.1:8091/healthz >/dev/null; then
                ready=true
                break
            fi
            sleep 1
        done
        if [[ "$ready" != true ]]; then
            printf '%s\n' 'Health check failed; the public vhost was not changed. Inspect journalctl -u ios-location-spoofer.' >&2
            exit 1
        fi
        apply_vhost "$deploy_dir/gps.x-cipher.com.conf"
        printf '%s\n' 'Service healthy; HTTPS vhost restored and startup enabled.'
        ;;
    status)
        systemctl is-active "$service_name" || true
        systemctl is-enabled "$service_name" || true
        ;;
    *)
        printf '%s\n' 'Usage: bash deploy/manage-service.sh [pause|resume|status]' >&2
        exit 2
        ;;
esac
