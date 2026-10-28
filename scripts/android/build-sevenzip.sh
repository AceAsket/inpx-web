#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
source "$task_root/scripts/android/abi-env.sh"
task_src="$task_tools/7zip-26.03"
task_archive="$task_tools/7z2603-src.tar.xz"
if [ ! -f "$task_archive" ]; then
    curl -fL --retry 5 --retry-all-errors https://github.com/ip7z/7zip/releases/download/26.03/7z2603-src.tar.xz -o "$task_archive"
fi
printf '%s  %s\n' 9cbde5099c6deb73691b0579063da5827522ccbbcba3f0020fd04e8c8c16c0d4 "$task_archive" | sha256sum -c -
mkdir -p "$task_src"
if [ ! -f "$task_src/CPP/7zip/Bundles/Alone2/makefile.gcc" ]; then tar -xf "$task_archive" -C "$task_src"; fi
# SAF/SMB proxy descriptors cannot be reopened through procfs on Android. The
# app explicitly inherits its read-only archive descriptor as fd 3; duplicate it.
python3 - "$task_src/CPP/Windows/FileIO.cpp" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.chmod(p.stat().st_mode | 0o200)
s = p.read_text()
old = '  _handle = ::open(name, flags, mode);'
new = '  _handle = (flags == O_RDONLY && strcmp(name, "/proc/self/fd/3") == 0) ? ::dup(3) : ::open(name, flags, mode);'
if old in s:
    s = '#include <string.h>\n' + s.replace(old, new)
    p.write_text(s)
elif new not in s:
    raise SystemExit('Unexpected 7-Zip FileIO source; refusing unreviewed patch')
PY
task_toolchain="$task_tools/sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/linux-x86_64"
cd "$task_src/CPP/7zip/Bundles/Alone2"
make -s -j4 -f makefile.gcc \
    O="_o-$task_arch-api$task_api" \
    CC="$task_toolchain/bin/$task_cc$task_api-clang" \
    CXX="$task_toolchain/bin/$task_cc$task_api-clang++" \
    USE_ASM= \
    MY_ARCH="$task_make_arch" \
    LOCAL_FLAGS='-D__ANDROID__ -D_FILE_OFFSET_BITS=64' \
    LIB2='-ldl' \
    LDFLAGS_STATIC='-static-libstdc++ -Wl,-z,max-page-size=16384' \
    DISABLE_RAR=1
mkdir -p "$task_root/android/app/src/main/jniLibs/$task_abi"
cp "_o-$task_arch-api$task_api/7zz" "$task_root/android/app/src/main/jniLibs/$task_abi/lib7zz.so"
"$task_toolchain/bin/llvm-strip" "$task_root/android/app/src/main/jniLibs/$task_abi/lib7zz.so"
mkdir -p "$task_root/android/app/src/main/assets"
cp "$task_src/DOC/License.txt" "$task_root/android/app/src/main/assets/LICENSE.7zip.txt"
cp "$task_src/DOC/copying.txt" "$task_root/android/app/src/main/assets/LICENSE.LGPL-7zip.txt"
