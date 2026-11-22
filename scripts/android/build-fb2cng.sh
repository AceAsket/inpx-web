#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
source "$task_root/scripts/android/abi-env.sh"
export PATH="$task_tools/converters/go/bin:$PATH"
python3 "$task_root/scripts/android/prepare-fbc-assets.py" "$task_tools/converters/fb2cng"
cd "$task_tools/converters/fb2cng"
env GOOS=linux GOARCH=amd64 CGO_ENABLED=0 GOFLAGS=-mod=vendor go tool go-enum --output-suffix _code --file common/enums.go --names --nocase --marshal --mustparse
export GOOS=android GOARCH="$task_go_arch" CGO_ENABLED=1 GOARM=7
export CC="$task_tools/sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/linux-x86_64/bin/$task_cc$task_api-clang"
export CXX="$task_tools/sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/linux-x86_64/bin/$task_cc$task_api-clang++"
cd "$task_tools/converters/fb2cng"
mkdir -p "$task_root/android/app/src/main/jniLibs/$task_abi" "$task_root/android/app/src/main/assets"
go build -mod=vendor -trimpath -buildvcs=false -ldflags='-s -w -linkmode=external -extldflags=-Wl,-z,max-page-size=16384' -o "$task_root/android/app/src/main/jniLibs/$task_abi/libfbc.so" ./cmd/fbc
cp LICENSE "$task_root/android/app/src/main/assets/LICENSE.fb2cng.txt"
