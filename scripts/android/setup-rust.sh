#!/usr/bin/env bash
set -euo pipefail
tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
export CARGO_HOME="$tools/rust/cargo"
export RUSTUP_HOME="$tools/rust/rustup"
mkdir -p "$CARGO_HOME"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$tools/rust/rustup-init.sh"
    sh "$tools/rust/rustup-init.sh" -y --no-modify-path --profile minimal --default-toolchain 1.100.0
fi
"$CARGO_HOME/bin/rustup" target add --toolchain 1.100.0 aarch64-linux-android armv7-linux-androideabi
