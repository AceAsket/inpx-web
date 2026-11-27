#!/bin/bash
set -euo pipefail

read_cmdline_args() {
    local cmdline_file="$1"
    CMDLINE_ARGS=()
    [ -r "$cmdline_file" ] || return 1

    local arg=""
    {
        while IFS= read -r -d '' arg; do
            CMDLINE_ARGS+=("$arg")
        done < "$cmdline_file"
    } 2>/dev/null || return 1

    if [ -n "$arg" ]; then
        CMDLINE_ARGS+=("$arg")
    fi
    [ "${#CMDLINE_ARGS[@]}" -gt 0 ]
}

read_ppid() {
    local status_file="$1"
    local line=""
    [ -r "$status_file" ] || return 1
    while IFS= read -r line; do
        case "$line" in
            PPid:*)
                line="${line#PPid:}"
                line="${line#"${line%%[![:space:]]*}"}"
                printf '%s' "$line"
                return 0
                ;;
        esac
    done < "$status_file" 2>/dev/null || return 1
    return 1
}

has_standalone_flag() {
    local arg
    for arg in "${CMDLINE_ARGS[@]:1}"; do
        if [ "$arg" = "--standalone" ]; then
            return 0
        fi
    done
    return 1
}

is_worker_process() {
    local arg1="${CMDLINE_ARGS[1]:-}"
    [[ "$arg1" == *jxl-worker* ]]
}

find_server_cmdline() {
    local self_pid="$$"
    local bash_pid="${BASHPID:-$$}"
    local best_inpx_web=()
    local best_standalone_p1=()
    local best_standalone=()
    local proc_dir pid arg0 base ppid

    for proc_dir in /proc/[0-9]*; do
        [ -d "$proc_dir" ] || continue
        pid="${proc_dir#/proc/}"
        if [ "$pid" = "$self_pid" ] || [ "$pid" = "$bash_pid" ]; then
            continue
        fi
        read_cmdline_args "${proc_dir}/cmdline" || continue
        if is_worker_process; then
            continue
        fi
        arg0="${CMDLINE_ARGS[0]}"
        base="${arg0##*/}"
        if [ "$base" = "inpx-web" ]; then
            ppid="$(read_ppid "${proc_dir}/status" || true)"
            if [ "$pid" = "1" ] || [ "$ppid" = "1" ]; then
                return 0
            fi
            if [ "${#best_inpx_web[@]}" -eq 0 ]; then
                best_inpx_web=("${CMDLINE_ARGS[@]}")
            fi
        elif [ "$base" = "inpx-server" ] && has_standalone_flag; then
            ppid="$(read_ppid "${proc_dir}/status" || true)"
            if [ "$pid" = "1" ] || [ "$ppid" = "1" ]; then
                if [ "${#best_standalone_p1[@]}" -eq 0 ]; then
                    best_standalone_p1=("${CMDLINE_ARGS[@]}")
                fi
            elif [ "${#best_standalone[@]}" -eq 0 ]; then
                best_standalone=("${CMDLINE_ARGS[@]}")
            fi
        fi
    done

    if [ "${#best_inpx_web[@]}" -gt 0 ]; then
        CMDLINE_ARGS=("${best_inpx_web[@]}")
        return 0
    fi
    if [ "${#best_standalone_p1[@]}" -gt 0 ]; then
        CMDLINE_ARGS=("${best_standalone_p1[@]}")
        return 0
    fi
    if [ "${#best_standalone[@]}" -gt 0 ]; then
        CMDLINE_ARGS=("${best_standalone[@]}")
        return 0
    fi

    CMDLINE_ARGS=()
    return 1
}

parse_server_cmdline() {
    CLI_PORT=""
    CLI_HOST=""
    CLI_DATA_DIR=""
    CLI_APP_DIR=""
    CLI_CONFIG=""

    local count="${#CMDLINE_ARGS[@]}"
    local i=1
    local arg="" flag="" val="" has_eq=0

    while [ "$i" -lt "$count" ]; do
        arg="${CMDLINE_ARGS[$i]}"
        has_eq=0
        if [[ "$arg" == *=* ]]; then
            flag="${arg%%=*}"
            val="${arg#*=}"
            has_eq=1
        else
            flag="$arg"
            val=""
        fi

        case "$flag" in
            --port|--host|--data-dir|--app-dir|--config)
                if [ "$has_eq" -eq 0 ]; then
                    if [ $((i + 1)) -lt "$count" ] && [[ "${CMDLINE_ARGS[$((i + 1))]}" != --* ]]; then
                        i=$((i + 1))
                        val="${CMDLINE_ARGS[$i]}"
                    else
                        val=""
                    fi
                fi
                if [ -n "$val" ]; then
                    case "$flag" in
                        --port) CLI_PORT="$val" ;;
                        --host) CLI_HOST="$val" ;;
                        --data-dir) CLI_DATA_DIR="$val" ;;
                        --app-dir) CLI_APP_DIR="$val" ;;
                        --config) CLI_CONFIG="$val" ;;
                    esac
                fi
                ;;
        esac
        i=$((i + 1))
    done
}

parse_config_json() {
    local config_file="$1"
    LC_ALL=C awk '
    function unescape_json(raw,    i, n, ch, nxt, out) {
        out = ""
        n = length(raw)
        i = 1
        while (i <= n) {
            ch = substr(raw, i, 1)
            if (ch == "\\" && i < n) {
                i++
                nxt = substr(raw, i, 1)
                if (nxt == "\"" || nxt == "\\" || nxt == "/") out = out nxt
                else if (nxt == "b") out = out "\b"
                else if (nxt == "f") out = out "\f"
                else if (nxt == "n") out = out "\n"
                else if (nxt == "r") out = out "\r"
                else if (nxt == "t") out = out "\t"
                else out = out nxt
            } else {
                out = out ch
            }
            i++
        }
        return out
    }
    { text = text $0 "\n" }
    END {
        sub(/^\357\273\277/, "", text)
        n = length(text)
        i = 1
        depth = 0
        in_server = 0
        top_key = ""
        sub_key = ""
        server_port = ""
        server_host = ""

        while (i <= n) {
            ch = substr(text, i, 1)
            if (ch == " " || ch == "\t" || ch == "\r" || ch == "\n") {
                i++
                continue
            }
            if (ch == "{") {
                if (depth == 1 && stack[1] == "{" && after_colon[1] && top_key == "server") {
                    in_server = 1
                }
                depth++
                stack[depth] = "{"
                expect_key[depth] = 1
                after_colon[depth] = 0
                i++
                continue
            }
            if (ch == "[") {
                depth++
                stack[depth] = "["
                expect_key[depth] = 0
                after_colon[depth] = 0
                i++
                continue
            }
            if (ch == "}" || ch == "]") {
                if (depth == 2 && in_server) {
                    in_server = 0
                    sub_key = ""
                }
                if (depth > 0) {
                    depth--
                    if (depth > 0) after_colon[depth] = 0
                }
                i++
                continue
            }
            if (ch == ":") {
                if (depth > 0 && stack[depth] == "{") {
                    expect_key[depth] = 0
                    after_colon[depth] = 1
                }
                i++
                continue
            }
            if (ch == ",") {
                if (depth > 0) {
                    after_colon[depth] = 0
                    if (stack[depth] == "{") {
                        expect_key[depth] = 1
                        if (depth == 1) top_key = ""
                        if (depth == 2 && in_server) sub_key = ""
                    }
                }
                i++
                continue
            }
            if (ch == "\"") {
                i++
                start = i
                while (i <= n) {
                    c = substr(text, i, 1)
                    if (c == "\\") {
                        i += 2
                        continue
                    }
                    if (c == "\"") break
                    i++
                }
                raw = substr(text, start, i - start)
                val = unescape_json(raw)
                i++
                if (depth == 1 && stack[1] == "{" && expect_key[1]) {
                    top_key = val
                    expect_key[1] = 0
                } else if (depth == 2 && in_server && stack[2] == "{") {
                    if (expect_key[2]) {
                        sub_key = val
                        expect_key[2] = 0
                    } else if (after_colon[2]) {
                        if (sub_key == "port") server_port = val
                        else if (sub_key == "host") server_host = val
                        after_colon[2] = 0
                    }
                }
                continue
            }
            start = i
            while (i <= n) {
                c = substr(text, i, 1)
                if (c == " " || c == "\t" || c == "\r" || c == "\n" || c == "," || c == "}" || c == "]" || c == ":" || c == "{" || c == "[" || c == "\"") break
                i++
            }
            if (i == start) {
                i++
                continue
            }
            prim = substr(text, start, i - start)
            if (depth == 2 && in_server && stack[2] == "{" && after_colon[2]) {
                if (sub_key == "port" && prim != "null") server_port = prim
                after_colon[2] = 0
            }
        }

        if (server_port != "" && server_port !~ /[\r\n]/) printf "port=%s\n", server_port
        if (server_host != "" && server_host !~ /[\r\n]/) printf "host=%s\n", server_host
    }
    ' "$config_file" 2>/dev/null
}

is_valid_port() {
    local value="$1"
    [[ "$value" =~ ^[0-9]+$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 ))
}

probe_health() {
    local host="$1"
    local port="$2"
    local status_line=""

    if ! { exec 3<>"/dev/tcp/${host}/${port}"; } 2>/dev/null; then
        return 1
    fi

    if ! printf 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3 2>/dev/null; then
        exec 3>&- 2>/dev/null || true
        return 1
    fi

    if ! IFS= read -r -t 3 status_line <&3 2>/dev/null; then
        exec 3>&- 2>/dev/null || true
        return 1
    fi
    exec 3>&- 2>/dev/null || true

    status_line="${status_line%$'\r'}"
    [[ "$status_line" =~ ^HTTP/[0-9.]+[[:space:]]+200([[:space:]]|$) ]]
}

CMDLINE_ARGS=()
CLI_PORT=""
CLI_HOST=""
CLI_DATA_DIR=""
CLI_APP_DIR=""
CLI_CONFIG=""

SERVER_CMDLINE_FOUND=0
if find_server_cmdline; then
    SERVER_CMDLINE_FOUND=1
    parse_server_cmdline
fi

DATA_DIR_VALUE="${CLI_DATA_DIR:-${CLI_APP_DIR:-${DATA_DIR:-${APP_DIR:-}}}}"
if [ -z "$DATA_DIR_VALUE" ] && [ -n "${CACHE_DIR:-}" ]; then
    DATA_DIR_VALUE="$(dirname "$CACHE_DIR")"
fi
DATA_DIR_VALUE="${DATA_DIR_VALUE:-/usr/local/bin/.inpx-web}"

CONFIG_FILE="${CLI_CONFIG:-${DATA_DIR_VALUE}/config.json}"
CONFIG_PORT=""
CONFIG_HOST=""
if [ -r "$CONFIG_FILE" ]; then
    while IFS='=' read -r key val; do
        case "$key" in
            port) CONFIG_PORT="$val" ;;
            host) CONFIG_HOST="$val" ;;
        esac
    done < <(parse_config_json "$CONFIG_FILE" || true)
fi

if [ "$SERVER_CMDLINE_FOUND" -eq 1 ]; then
    EFFECTIVE_PORT="${CLI_PORT:-${CONFIG_PORT:-12380}}"
    EFFECTIVE_HOST="${CLI_HOST:-${CONFIG_HOST:-0.0.0.0}}"
else
    EFFECTIVE_PORT="${PORT:-${CONFIG_PORT:-12380}}"
    EFFECTIVE_HOST="${HOST:-${CONFIG_HOST:-0.0.0.0}}"
fi
is_valid_port "$EFFECTIVE_PORT" || exit 1
EFFECTIVE_PORT="$((10#$EFFECTIVE_PORT))"
if [[ "$EFFECTIVE_HOST" == \[*\] ]]; then
    EFFECTIVE_HOST="${EFFECTIVE_HOST#[}"
    EFFECTIVE_HOST="${EFFECTIVE_HOST%]}"
fi

PROBE_HOSTS=()
case "$EFFECTIVE_HOST" in
    ""|"0.0.0.0"|"*")
        PROBE_HOSTS=("127.0.0.1" "::1")
        ;;
    "::")
        PROBE_HOSTS=("::1" "127.0.0.1")
        ;;
    "localhost")
        PROBE_HOSTS=("127.0.0.1" "::1")
        ;;
    *)
        PROBE_HOSTS=("$EFFECTIVE_HOST")
        ;;
esac

for probe_host in "${PROBE_HOSTS[@]}"; do
    if probe_health "$probe_host" "$EFFECTIVE_PORT"; then
        exit 0
    fi
done

exit 1
