#!/usr/bin/env bash
set -euo pipefail
image="$1"
test_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/inpx-converters.XXXXXX")
trap 'rm -rf "$test_root"' EXIT
for tool in fbc kindling djxl 7z; do
    tool_path="/usr/local/bin/$tool"
    if [[ "$tool" == djxl || "$tool" == 7z ]]; then tool_path="/usr/bin/$tool"; fi
    printf '#!/bin/sh\nexec docker run --rm --user "%s:%s" -v "%s:%s" -w "$PWD" --entrypoint %s "%s" "$@"\n' "$(id -u)" "$(id -g)" "$test_root" "$test_root" "$tool_path" "$image" > "$test_root/$tool"
    chmod +x "$test_root/$tool"
done
TMPDIR="$test_root" node scripts/fb2cng-integration-tests.js --fbc "$test_root/fbc"
TMPDIR="$test_root" node scripts/mobi-integration-tests.js --fbc "$test_root/fbc" --kindling "$test_root/kindling"
TMPDIR="$test_root" node scripts/resource-benchmark-integration.js --fbc "$test_root/fbc" --djxl "$test_root/djxl" --sevenzip "$test_root/7z"
