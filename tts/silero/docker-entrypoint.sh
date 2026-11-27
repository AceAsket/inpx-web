#!/bin/sh
set -e

MODEL_DIR_VALUE="${SILERO_MODEL_DIR:-/models}"
if [ "$(id -u)" -eq 0 ] && id silero >/dev/null 2>&1; then
    mkdir -p -- "$MODEL_DIR_VALUE"
    chown -R silero:silero -- "$MODEL_DIR_VALUE" 2>/dev/null || true
    if setpriv --reuid=silero --regid=silero --init-groups test -w "$MODEL_DIR_VALUE" 2>/dev/null \
        || { [ ! -w "$MODEL_DIR_VALUE" ] && setpriv --reuid=silero --regid=silero --init-groups test -r "$MODEL_DIR_VALUE" 2>/dev/null; }; then
        exec setpriv --reuid=silero --regid=silero --init-groups "$@"
    fi
fi

exec "$@"
