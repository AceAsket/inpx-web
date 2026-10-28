#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
source "$task_root/scripts/android/abi-env.sh"
for task_binary in lib7zz.so libfbc.so libmutool.so libkindling.so; do
    if [ ! -s "$task_root/android/app/src/main/jniLibs/$task_abi/$task_binary" ]; then
        printf 'Build %s for %s before assembling the full APK\n' "$task_binary" "$task_abi" >&2
        exit 1
    fi
done
export ANDROID_HOME="$task_tools/sdk"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djdk.tls.client.protocols=TLSv1.2"
cd "$task_root/android"
"$task_tools/gradle-8.13/bin/gradle" --console=plain --no-daemon "-PinpxAbi=$task_abi" assembleDebug "$@"
mkdir -p "$task_root/dist/android"
task_version="$(sed -n "s/.*versionName '\([^']*\)-prototype'.*/\1/p" app/build.gradle)"
task_apk="$task_root/dist/android/inpx-server-$task_version-$task_arch-debug.apk"
cp app/build/outputs/apk/debug/app-debug.apk "$task_apk"
(
    cd "$(dirname "$task_apk")"
    sha256sum "$(basename "$task_apk")"
) | tee "$task_apk.sha256"
