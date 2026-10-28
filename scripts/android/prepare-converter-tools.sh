#!/usr/bin/env bash
set -euo pipefail
task_tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
mkdir -p "$task_tools/converters"
cd "$task_tools/converters"
fetch() { if [ ! -s "$2" ]; then curl -fL --tlsv1.2 --tls-max 1.2 --retry 5 --retry-all-errors "$1" -o "$2"; fi; }
fetch https://go.dev/dl/go1.27.3.linux-amd64.tar.gz go1.27.3.tar.gz
printf '%s  %s\n' 65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40 go1.27.3.tar.gz | sha256sum -c -
if [ ! -x go/bin/go ]; then tar -xf go1.27.3.tar.gz; fi
fetch https://codeload.github.com/rupor-github/fb2cng/tar.gz/81c612754b65cef23871ba7366aa86451b347367 fb2cng.tar.gz
printf '%s  %s\n' 8f001c5e356e4a3f1ddeba0577b59c3cbe2918815afe0edc3e8aadaa3845ac71 fb2cng.tar.gz | sha256sum -c -
if [ ! -d fb2cng ]; then mkdir fb2cng; tar -xf fb2cng.tar.gz --strip-components=1 -C fb2cng; fi
fetch https://codeload.github.com/ciscoriordan/kindling/tar.gz/refs/tags/v0.45.6 kindling.tar.gz
printf '%s  %s\n' 6b85364aa51c041c2920fade89f2695a3037bda607bb71051df0ca5f25e9d0b3 kindling.tar.gz | sha256sum -c -
if [ ! -d kindling ]; then mkdir kindling; tar -xf kindling.tar.gz --strip-components=1 -C kindling; fi
sha256sum fb2cng.tar.gz kindling.tar.gz
find fb2cng -maxdepth 2 -name main.go -o -name '*Task*' -o -name LICENSE
if [ ! -x "$task_tools/cargo/bin/cargo" ]; then
    curl -fL --retry 5 --retry-all-errors https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o rustup-init
    chmod u+x rustup-init
    CARGO_HOME="$task_tools/cargo" RUSTUP_HOME="$task_tools/rustup" ./rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.99.1
fi
RUSTUP_HOME="$task_tools/rustup" "$task_tools/cargo/bin/rustup" target add aarch64-linux-android
fetch https://mupdf.com/downloads/archive/mupdf-1.27.0-source.tar.gz mupdf.tar.gz
printf '%s  %s\n' ae2442416de499182d37a526c6fa2bacc7a3bed5a888d113ca04844484dfe7c6 mupdf.tar.gz | sha256sum -c -
if [ ! -d mupdf ]; then mkdir mupdf; tar -xf mupdf.tar.gz --strip-components=1 -C mupdf; fi
sha256sum mupdf.tar.gz
