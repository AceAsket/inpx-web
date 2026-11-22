#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
abi="${INPX_ANDROID_ABI:-arm64-v8a}"
case "$abi" in
    arm64-v8a) arch=arm64 ;;
    armeabi-v7a) arch=arm32 ;;
    *) echo "Unsupported ABI: $abi" >&2; exit 1 ;;
esac
test -s "$root/android/app/src/main/jniLibs/$abi/libinpxserver.so"
test -s "$root/android/app/src/main/assets/runtime.zip"
export ANDROID_HOME="$tools/sdk"
cd "$root/android"
"$tools/gradle-8.13/bin/gradle" --console=plain --offline --no-daemon --max-workers=3 \
    "-PinpxAbi=$abi" :app:assembleDebug "$@"
mkdir -p "$root/dist/android"
file="$root/dist/android/inpx-rust-0.8.0-$arch-preview.apk"
cp app/build/outputs/apk/debug/app-debug.apk "$file"
sha256sum "$file" > "$file.sha256"
echo "$file"
