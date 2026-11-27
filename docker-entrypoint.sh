#!/bin/sh
set -e

DATA_DIR_VALUE="${DATA_DIR:-${APP_DIR:-}}"
if [ -z "$DATA_DIR_VALUE" ] && [ -n "$CACHE_DIR" ]; then
    DATA_DIR_VALUE="$(dirname "$CACHE_DIR")"
fi
DATA_DIR_VALUE="${DATA_DIR_VALUE:-/usr/local/bin/.inpx-web}"
LIBDIR_VALUE="${LIBDIR:-${LIB_DIR:-/library}}"
INPX_VALUE="${INPX:-}"

can_drop_to_inpx() {
    [ "$(id -u)" -eq 0 ] && [ "${INPX_ALLOW_ROOT:-}" != "true" ] && id inpx >/dev/null 2>&1
}

exec_as_inpx_if_possible() {
    target_data_dir="$1"
    target_lib_dir="$2"
    shift 2

    if can_drop_to_inpx; then
        if [ -z "$target_lib_dir" ] || [ ! -e "$target_lib_dir" ] || setpriv --reuid=inpx --regid=inpx --init-groups test -r "$target_lib_dir" 2>/dev/null; then
            if [ -n "$target_data_dir" ]; then
                mkdir -p -- "$target_data_dir"
                chown -R inpx:inpx -- "$target_data_dir" 2>/dev/null || true
                if [ -w "$target_data_dir" ] && ! setpriv --reuid=inpx --regid=inpx --init-groups test -w "$target_data_dir" 2>/dev/null; then
                    exec "$@"
                fi
            fi
            exec setpriv --reuid=inpx --regid=inpx --init-groups "$@"
        fi
    fi

    exec "$@"
}

if [ "$#" -gt 0 ]; then
    case "$1" in
        -*)
            has_data_dir=0
            info_only=0
            expect_value=""
            CLI_DATA_DIR=""
            CLI_LIB_DIR=""
            for arg in "$@"; do
                if [ -n "$expect_value" ]; then
                    case "$expect_value" in
                        data) CLI_DATA_DIR="$arg" ;;
                        lib) CLI_LIB_DIR="$arg" ;;
                    esac
                    expect_value=""
                    continue
                fi
                case "$arg" in
                    --help|-h|--version|-v)
                        has_data_dir=1
                        info_only=1
                        ;;
                    --data-dir|--app-dir)
                        has_data_dir=1
                        expect_value="data"
                        ;;
                    --data-dir=*|--app-dir=*)
                        has_data_dir=1
                        CLI_DATA_DIR="${arg#*=}"
                        ;;
                    --lib-dir)
                        expect_value="lib"
                        ;;
                    --lib-dir=*)
                        CLI_LIB_DIR="${arg#*=}"
                        ;;
                esac
            done

            if [ "$info_only" -eq 1 ]; then
                exec_as_inpx_if_possible "" "" inpx-web "$@"
            fi

            if [ "$has_data_dir" -eq 1 ]; then
                EFFECTIVE_DATA_DIR="$CLI_DATA_DIR"
                set -- inpx-web "$@"
            else
                EFFECTIVE_DATA_DIR="$DATA_DIR_VALUE"
                set -- inpx-web "--data-dir=$DATA_DIR_VALUE" "$@"
            fi

            EFFECTIVE_LIB_DIR="${CLI_LIB_DIR:-$LIBDIR_VALUE}"
            exec_as_inpx_if_possible "$EFFECTIVE_DATA_DIR" "$EFFECTIVE_LIB_DIR" "$@"
            ;;
        *)
            exec "$@"
            ;;
    esac
fi

set -- inpx-web \
    "--data-dir=$DATA_DIR_VALUE" \
    "--lib-dir=$LIBDIR_VALUE"

if [ -n "${HOST:-}" ]; then
    set -- "$@" "--host=$HOST"
fi

if [ -n "${PORT:-}" ]; then
    set -- "$@" "--port=$PORT"
fi

if [ -n "$INPX_VALUE" ]; then
    set -- "$@" "--inpx=$INPX_VALUE"
fi

exec_as_inpx_if_possible "$DATA_DIR_VALUE" "$LIBDIR_VALUE" "$@"
