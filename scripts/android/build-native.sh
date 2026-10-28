#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
for task_tool in sevenzip fb2cng kindling mupdf; do
    bash "$task_root/scripts/android/build-$task_tool.sh"
done
