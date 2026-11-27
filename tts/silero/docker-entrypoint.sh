#!/bin/sh
set -e

MODEL_DIR_VALUE="${SILERO_MODEL_DIR:-/models}"
if [ "$(id -u)" -eq 0 ] && id silero >/dev/null 2>&1; then
    if [ ! -e "$MODEL_DIR_VALUE" ]; then
        install -d -o silero -g silero -- "$MODEL_DIR_VALUE" || exec "$@"
    fi
    if setpriv --reuid=silero --regid=silero --init-groups test -O "$MODEL_DIR_VALUE" \
        && setpriv --reuid=silero --regid=silero --init-groups test -w "$MODEL_DIR_VALUE"; then
        exec setpriv --reuid=silero --regid=silero --init-groups "$@"
    fi
fi

exec "$@"
