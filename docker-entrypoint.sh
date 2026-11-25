#!/bin/sh
set -e

DATA_DIR_VALUE="${DATA_DIR:-${APP_DIR:-}}"
if [ -z "$DATA_DIR_VALUE" ] && [ -n "$CACHE_DIR" ]; then
    DATA_DIR_VALUE="$(dirname "$CACHE_DIR")"
fi
DATA_DIR_VALUE="${DATA_DIR_VALUE:-/usr/local/bin/.inpx-web}"

if [ "$#" -gt 0 ]; then
    case "$1" in
        --reset-admin-network)
            exec inpx-web "--data-dir=$DATA_DIR_VALUE" "$@"
            ;;
        -*)
            exec inpx-web "$@"
            ;;
        *)
            exec "$@"
            ;;
    esac
fi

LIBDIR_VALUE="${LIBDIR:-${LIB_DIR:-/library}}"
INPX_VALUE="${INPX:-}"
HOST_VALUE="${HOST:-0.0.0.0}"
PORT_VALUE="${PORT:-12380}"

set -- inpx-web \
    "--host=$HOST_VALUE" \
    "--port=$PORT_VALUE" \
    "--data-dir=$DATA_DIR_VALUE" \
    "--lib-dir=$LIBDIR_VALUE"

if [ -n "$INPX_VALUE" ]; then
    set -- "$@" "--inpx=$INPX_VALUE"
fi

exec "$@"
