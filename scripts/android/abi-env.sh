#!/usr/bin/env bash
# Shared native target selection. Sourced by the build scripts.
task_abi="${INPX_ANDROID_ABI:-arm64-v8a}"
task_api=28
case "$task_abi" in
    arm64-v8a)
        task_arch=arm64
        task_cc=aarch64-linux-android
        task_go_arch=arm64
        task_rust_target=aarch64-linux-android
        task_make_arch='-march=armv8-a'
        ;;
    armeabi-v7a)
        task_arch=arm32
        task_cc=armv7a-linux-androideabi
        task_go_arch=arm
        task_rust_target=armv7-linux-androideabi
        task_make_arch='-march=armv7-a -mfpu=neon -mfloat-abi=softfp'
        ;;
    *) printf 'Unsupported Android ABI: %s\n' "$task_abi" >&2; return 1 ;;
esac
