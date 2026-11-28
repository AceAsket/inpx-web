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

as_inpx() {
    setpriv --reuid=inpx --regid=inpx --init-groups "$@"
}

exec_as_inpx_if_possible() {
    target_data_dir="$1"
    target_lib_dir="$2"
    target_config="$3"
    shift 3

    if can_drop_to_inpx; then
        if [ -n "$target_data_dir" ]; then
            target_config="${target_config:-$target_data_dir/config.json}"
            if [ -e "$target_config" ]; then
                as_inpx test -r "$target_config" || exec "$@"
                as_inpx test -w "$(dirname -- "$target_config")" || exec "$@"
                configured_data=$(jq -r '.dataDir | strings | select(length > 0)' "$target_config" 2>/dev/null) || exec "$@"
                target_data_dir="${configured_data:-$target_data_dir}"
            fi
            if [ ! -e "$target_data_dir" ]; then
                install -d -o inpx -g inpx -- "$target_data_dir" || exec "$@"
            fi
            # Bind mounts can already hold working installations owned by another UID.
            as_inpx test -O "$target_data_dir" || exec "$@"
            as_inpx test -w "$target_data_dir" || exec "$@"
        fi
        if [ -n "$target_lib_dir" ] && [ -e "$target_lib_dir" ]; then
            as_inpx test -r "$target_lib_dir" && as_inpx test -x "$target_lib_dir" || exec "$@"
        fi
        exec setpriv --reuid=inpx --regid=inpx --init-groups "$@"
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
            CLI_CONFIG=""
            for arg in "$@"; do
                if [ -n "$expect_value" ]; then
                    case "$expect_value" in
                        data) CLI_DATA_DIR="$arg" ;;
                        lib) CLI_LIB_DIR="$arg" ;;
                        config) CLI_CONFIG="$arg" ;;
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
                    --config)
                        expect_value="config"
                        ;;
                    --config=*)
                        CLI_CONFIG="${arg#*=}"
                        ;;
                esac
            done

            if [ "$info_only" -eq 1 ]; then
                exec_as_inpx_if_possible "" "" "" inpx-web "$@"
            fi

            if [ "$has_data_dir" -eq 1 ]; then
                EFFECTIVE_DATA_DIR="${CLI_DATA_DIR:-/usr/local/bin/.inpx-web}"
                set -- inpx-web "$@"
            else
                EFFECTIVE_DATA_DIR="$DATA_DIR_VALUE"
                set -- inpx-web "--data-dir=$DATA_DIR_VALUE" "$@"
            fi

            EFFECTIVE_LIB_DIR="${CLI_LIB_DIR:-$LIBDIR_VALUE}"
            exec_as_inpx_if_possible "$EFFECTIVE_DATA_DIR" "$EFFECTIVE_LIB_DIR" "$CLI_CONFIG" "$@"
            ;;
        *)
            exec "$@"
            ;;
    esac
fi

set -- inpx-web \
    "--host=${HOST:-0.0.0.0}" \
    "--port=${PORT:-12380}" \
    "--data-dir=$DATA_DIR_VALUE" \
    "--lib-dir=$LIBDIR_VALUE"

if [ -n "$INPX_VALUE" ]; then
    set -- "$@" "--inpx=$INPX_VALUE"
fi

exec_as_inpx_if_possible "$DATA_DIR_VALUE" "$LIBDIR_VALUE" "" "$@"
