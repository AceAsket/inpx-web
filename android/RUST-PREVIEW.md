# INPX Server Rust for Android

The `android-rust` branch builds the standalone Rust server from the current Rust source together with the native Android server panel. The preview targets Android 9+ and uses the separate application ID `ru.inpx.server.rust`. Its launcher name is **INPX Rust Preview**.

The Rust ELF is packaged as `libinpxserver.so` so Android installs it into its executable native-library directory. The foreground service launches it with `--standalone`, keeps its wake lock according to the power settings, polls startup progress, and terminates the child on cancellation or shutdown. ZIP and 7z are decoded by the Rust server.

The first preview is intended for the bundled demo and filesystem-readable local directories. The existing SAF/USB and SMB bridge needs a Rust adapter for arbitrary document providers and network archives. These sources currently report an error when the Rust process cannot read their directory directly. External converters and the native INPX Reader are separate follow-up integration work for this preview.

Rust uses the economy resource profile and bounded catalogue caches. The old V8 heap-limit control is omitted from the settings. The web administration panel exposes the Rust process metrics.

## Build

Use Node.js 24+ to build the web assets, and Ubuntu/WSL with the Android SDK/NDK used by the existing Android scripts. `setup-rust.sh` installs Rust 1.100.0 and its Android targets in `~/.cache/inpx-android/rust`. QuickJS bindings use libclang and headers from NDK 28.2.13676358. ARM32 also generates AWS-LC bindings with the NDK CMake toolchain.

```powershell
wsl -d Ubuntu -- bash scripts/android/setup-rust.sh
node node_modules/webpack/bin/webpack.js --config build/webpack.prod.config.js
node scripts/android/prepare-rust-assets.js
wsl -d Ubuntu -- env INPX_ANDROID_ABI=arm64-v8a bash scripts/android/build-rust.sh
wsl -d Ubuntu -- env INPX_ANDROID_ABI=arm64-v8a bash scripts/android/build-rust-apk.sh :app:testDebugUnitTest :app:lintDebug
wsl -d Ubuntu -- env INPX_ANDROID_ABI=armeabi-v7a bash scripts/android/build-rust.sh
wsl -d Ubuntu -- env INPX_ANDROID_ABI=armeabi-v7a bash scripts/android/build-rust-apk.sh
```

Supply `INPX_ANDROID_KEYSTORE_FILE` to use the existing server signing key. APKs are written to `dist/android` with architecture-specific names and SHA256 files.

## Device verification

`RustSmokeInstrumentation` checks the demo through the actual Android foreground service. It starts the Rust server, verifies readiness and catalogue counts, opens Web and OPDS routes, searches for both demo books, downloads their FB2 content from ZIP and 7z, stops and restarts the service, and stops the service at the end.

```powershell
wsl -d Ubuntu -- env INPX_ANDROID_ABI=arm64-v8a bash scripts/android/build-rust-apk.sh :app:assembleDebugAndroidTest
adb install -r -g dist/android/inpx-rust-0.8.0-arm64-preview.apk
adb install -r -g android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w ru.inpx.server.rust.test/ru.inpx.server.RustSmokeInstrumentation
```

ARM64 passed this test on a Lenovo TB321FU running Android 16. ARM32 builds require a separate 32-bit device run to verify execution. Gradle unit tests and Android Lint are additional build checks.
