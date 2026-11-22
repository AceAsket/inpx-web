#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
export CARGO_HOME="$tools/rust/cargo"
export RUSTUP_HOME="$tools/rust/rustup"
export PATH="$CARGO_HOME/bin:$tools/sdk/cmake/3.22.1/bin:$PATH"
ndk="$tools/sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/linux-x86_64"
export ANDROID_NDK_ROOT="$tools/sdk/ndk/28.2.13676358"
export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
export CMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_ROOT/build/cmake/android.toolchain.cmake"
export CMAKE_GENERATOR=Ninja
export LIBCLANG_PATH="$ndk/lib"
abi="${INPX_ANDROID_ABI:-arm64-v8a}"
case "$abi" in
    arm64-v8a) target=aarch64-linux-android; clang=aarch64-linux-android28; headers=aarch64-linux-android ;;
    armeabi-v7a) target=armv7-linux-androideabi; clang=armv7a-linux-androideabi28; headers=arm-linux-androideabi ;;
    *) echo "Unsupported ABI: $abi" >&2; exit 1 ;;
esac
export "CC_${target//-/_}=$ndk/bin/$clang-clang"
export "CXX_${target//-/_}=$ndk/bin/$clang-clang++"
export "AR_${target//-/_}=$ndk/bin/llvm-ar"
export "BINDGEN_EXTRA_CLANG_ARGS_${target//-/_}=--sysroot=$ndk/sysroot -isystem $ndk/lib/clang/19/include -isystem $ndk/sysroot/usr/include/$headers"
target_env="${target^^}"
target_env="${target_env//-/_}"
export "CARGO_TARGET_${target_env}_LINKER=$ndk/bin/$clang-clang"
export "CARGO_TARGET_${target_env}_RUSTFLAGS=-C link-arg=-Wl,-z,max-page-size=16384"
export CARGO_TARGET_DIR="$tools/rust/target"
cd "$root"
cargo +1.100.0 build --manifest-path rust/Cargo.toml --locked --release --target "$target" -p inpx-server
mkdir -p "$root/android/app/src/main/jniLibs/$abi"
cp "$CARGO_TARGET_DIR/$target/release/inpx-server" "$root/android/app/src/main/jniLibs/$abi/libinpxserver.so"
"$ndk/bin/llvm-strip" "$root/android/app/src/main/jniLibs/$abi/libinpxserver.so"
