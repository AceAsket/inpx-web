#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
source "$task_root/scripts/android/abi-env.sh"
printf '%s  %s\n' ae2442416de499182d37a526c6fa2bacc7a3bed5a888d113ca04844484dfe7c6 "$task_tools/converters/mupdf.tar.gz" | sha256sum -c -
task_bin="$task_tools/sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/linux-x86_64/bin"
cd "$task_tools/converters/mupdf"
make -s -j2 build=release OS=Android OUT="build/android-$task_arch-api$task_api" \
    CC="$task_bin/$task_cc$task_api-clang" \
    CXX="$task_bin/$task_cc$task_api-clang++" AR="$task_bin/llvm-ar" \
    RANLIB="$task_bin/llvm-ranlib" XCFLAGS='-fPIC -D_FILE_OFFSET_BITS=64' XLDFLAGS='-Wl,-z,max-page-size=16384' XLIBS='-llog' \
    HAVE_GLUT=no HAVE_X11=no HAVE_SYS_CURL=no HAVE_LIBCRYPTO=no HAVE_PTHREAD=yes PTHREAD_LIBS= \
    USE_SYSTEM_LIBS=no USE_SYSTEM_CURL=no USE_TESSERACT=no USE_LEPTONICA=no USE_ZXINGCPP=no \
    extract=no mujs=no "build/android-$task_arch-api$task_api/mutool"
mkdir -p "$task_root/android/app/src/main/jniLibs/$task_abi"
cp "build/android-$task_arch-api$task_api/mutool" "$task_root/android/app/src/main/jniLibs/$task_abi/libmutool.so"
"$task_bin/llvm-strip" "$task_root/android/app/src/main/jniLibs/$task_abi/libmutool.so"
cp COPYING "$task_root/android/app/src/main/assets/LICENSE.mupdf.txt"
