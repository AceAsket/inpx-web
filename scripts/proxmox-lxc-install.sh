#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage:
  sudo ./scripts/proxmox-lxc-install.sh --library-dir /path/to/library --inpx-file my-library.inpx [options]

Required:
  --library-dir PATH     Directory with the book library mounted inside the LXC
  --inpx-file NAME       .inpx filename inside --library-dir

Optional:
  --app-root PATH        Where to copy the project and compose files
                         Default: /opt/inpx-web
  --data-dir PATH        Persistent app data directory
                         Default: /opt/inpx-web-data
  --port PORT            Published HTTP port
                         Default: 12380
  --lite                 Build the runtime-lite Docker target
  --skip-build           Do not rebuild image, only (re)start compose stack
  --project-name NAME    Docker compose project name
                         Default: inpx-web
  --help                 Show this help

Examples:
  sudo ./scripts/proxmox-lxc-install.sh \
    --library-dir /mnt/books/flibusta \
    --inpx-file fb2.flibusta.lib.rus.ec.7z.inpx

  sudo ./scripts/proxmox-lxc-install.sh \
    --library-dir /srv/library \
    --inpx-file my-library.inpx \
    --data-dir /srv/inpx-web-data \
    --port 18080 \
    --lite

Notes:
  - This script is intended to run inside a Debian/Ubuntu Proxmox LXC.
  - Docker inside LXC requires nesting/keyctl to be enabled on the container.
  - The script copies the current repository into --app-root and runs Docker Compose there.
EOF
}

log() {
    printf '[inpx-web] %s\n' "$*"
}

fail() {
    printf '[inpx-web] ERROR: %s\n' "$*" >&2
    exit 1
}

require_root() {
    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
        fail "Run this script with sudo or as root."
    fi
}

detect_repo_root() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "${script_dir}/.." && pwd)"
    [[ -f "${REPO_ROOT}/Dockerfile" ]] || fail "Dockerfile not found next to the script."
}

parse_args() {
    APP_ROOT="/opt/inpx-web"
    DATA_DIR="/opt/inpx-web-data"
    PORT="12380"
    PROJECT_NAME="inpx-web"
    LIBRARY_DIR=""
    INPX_FILE=""
    DOCKER_TARGET="final"
    SKIP_BUILD="0"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --library-dir)
                LIBRARY_DIR="${2:-}"
                shift 2
                ;;
            --inpx-file)
                INPX_FILE="${2:-}"
                shift 2
                ;;
            --app-root)
                APP_ROOT="${2:-}"
                shift 2
                ;;
            --data-dir)
                DATA_DIR="${2:-}"
                shift 2
                ;;
            --port)
                PORT="${2:-}"
                shift 2
                ;;
            --project-name)
                PROJECT_NAME="${2:-}"
                shift 2
                ;;
            --lite)
                DOCKER_TARGET="runtime-lite"
                shift
                ;;
            --skip-build)
                SKIP_BUILD="1"
                shift
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                fail "Unknown argument: $1"
                ;;
        esac
    done

    [[ -n "${LIBRARY_DIR}" ]] || fail "--library-dir is required."
    [[ -n "${INPX_FILE}" ]] || fail "--inpx-file is required."
    [[ "${PORT}" =~ ^[0-9]+$ ]] || fail "--port must be numeric."
}

validate_paths() {
    LIBRARY_DIR="$(realpath "${LIBRARY_DIR}")"
    mkdir -p "${APP_ROOT}" "${DATA_DIR}"
    APP_ROOT="$(realpath "${APP_ROOT}")"
    DATA_DIR="$(realpath "${DATA_DIR}")"

    [[ -d "${LIBRARY_DIR}" ]] || fail "Library directory does not exist: ${LIBRARY_DIR}"
    [[ -f "${LIBRARY_DIR}/${INPX_FILE}" ]] || fail "INPX file not found: ${LIBRARY_DIR}/${INPX_FILE}"
}

install_base_packages() {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        lsb-release \
        rsync
}

ensure_runtime_tools() {
    if command -v rsync >/dev/null 2>&1; then
        return
    fi
    log "Installing rsync."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends rsync
}

install_docker_if_needed() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        log "Docker and Docker Compose already installed."
        return
    fi

    log "Installing Docker Engine and Docker Compose plugin."
    install_base_packages
    install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
        curl -fsSL https://download.docker.com/linux/$(. /etc/os-release; echo "${ID}")/gpg -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
    fi

    . /etc/os-release
    cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable
EOF

    apt-get update
    apt-get install -y --no-install-recommends \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin

    systemctl enable --now docker
}

check_lxc_docker_prereqs() {
    if ! docker info >/dev/null 2>&1; then
        cat >&2 <<'EOF'
[inpx-web] ERROR: Docker daemon is not usable inside this LXC.
Make sure the Proxmox container has nesting enabled and keyctl available, for example:
  pct set <CTID> -features nesting=1,keyctl=1
Then restart the container and rerun this script.
EOF
        exit 1
    fi
}

sync_repo() {
    log "Copying repository into ${APP_ROOT}."
    rsync -a --delete \
        --exclude .git \
        --exclude node_modules \
        --exclude dist \
        --exclude build/app \
        "${REPO_ROOT}/" "${APP_ROOT}/"
}

write_compose_file() {
    local compose_path="${APP_ROOT}/docker-compose.proxmox.yml"
    log "Writing ${compose_path}."
    cat > "${compose_path}" <<EOF
services:
  inpx-web:
    build:
      context: .
      target: ${DOCKER_TARGET}
    image: ${PROJECT_NAME}:local
    container_name: ${PROJECT_NAME}
    restart: unless-stopped
    ports:
      - "${PORT}:12380"
    environment:
      INPX: /library/${INPX_FILE}
      LIBDIR: /library
      CACHE_DIR: /usr/local/bin/.inpx-web/cache
    volumes:
      - ${DATA_DIR}:/usr/local/bin/.inpx-web
      - ${LIBRARY_DIR}:/library:ro
EOF
}

build_and_start() {
    cd "${APP_ROOT}"
    if [[ "${SKIP_BUILD}" == "0" ]]; then
        log "Building Docker image."
        docker compose -p "${PROJECT_NAME}" -f docker-compose.proxmox.yml build
    else
        log "Skipping image build."
    fi

    log "Starting stack."
    docker compose -p "${PROJECT_NAME}" -f docker-compose.proxmox.yml up -d
}

print_summary() {
    local host_ip
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    cat <<EOF

[inpx-web] Done.
  App root:    ${APP_ROOT}
  Data dir:    ${DATA_DIR}
  Library dir: ${LIBRARY_DIR}
  INPX file:   ${INPX_FILE}
  Port:        ${PORT}
  Compose:     ${APP_ROOT}/docker-compose.proxmox.yml

Open:
  http://${host_ip:-<container-ip>}:${PORT}

Useful commands:
  cd ${APP_ROOT}
  docker compose -p ${PROJECT_NAME} -f docker-compose.proxmox.yml logs -f
  docker compose -p ${PROJECT_NAME} -f docker-compose.proxmox.yml up -d --build
  docker compose -p ${PROJECT_NAME} -f docker-compose.proxmox.yml down
EOF
}

main() {
    require_root
    detect_repo_root
    parse_args "$@"
    validate_paths
    ensure_runtime_tools
    install_docker_if_needed
    check_lxc_docker_prereqs
    sync_repo
    write_compose_file
    build_and_start
    print_summary
}

main "$@"
