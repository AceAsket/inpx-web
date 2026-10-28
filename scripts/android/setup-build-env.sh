#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_tools="${INPX_ANDROID_TOOLS:-$HOME/.cache/inpx-android}"
mkdir -p "$task_tools"
export ANDROID_HOME="$task_tools/sdk"
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
    curl -fL --retry 3 https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o "$task_tools/commandlinetools.zip"
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    unzip -q -o "$task_tools/commandlinetools.zip" -d "$ANDROID_HOME/cmdline-tools"
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi
set +o pipefail
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > "$task_tools/licenses.log" 2>&1
set -o pipefail
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" 'platforms;android-36' 'build-tools;36.0.0' 'ndk;28.2.13676358' 'cmake;3.22.1'
if [ ! -x "$task_tools/gradle-8.13/bin/gradle" ]; then
    curl -fL --retry 3 https://services.gradle.org/distributions/gradle-8.13-bin.zip -o "$task_tools/gradle.zip"
    task_gradle_hash="$(curl -fsL https://services.gradle.org/distributions/gradle-8.13-bin.zip.sha256)"
    printf '%s  %s\n' "$task_gradle_hash" "$task_tools/gradle.zip" | sha256sum -c -
    unzip -q -o "$task_tools/gradle.zip" -d "$task_tools"
fi
python3 - "$task_root" "$task_tools" <<'PY'
import hashlib, json, pathlib, sys, subprocess, zipfile
root, tools = map(pathlib.Path, sys.argv[1:])
lock = json.loads((root / 'android/runtime.lock.json').read_text())
archive = tools / ('nodejs-mobile-' + lock['version'] + '.zip')
if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != lock['sha256']:
    subprocess.run(['curl', '-fL', '--retry', '5', '--retry-all-errors', lock['url'], '-o', str(archive)], check=True)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == lock['sha256'], 'Node runtime checksum mismatch'
dest = root / 'android/libnode'
dest.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as z:
    z.extractall(dest)
(root / 'android/local.properties').write_text('sdk.dir=' + str(tools / 'sdk') + '\n')
print('Node runtime verified and extracted')
PY
mkdir -p "$task_root/android/app/src/main/assets"
curl -fL --retry 3 https://raw.githubusercontent.com/fogtape/nodejs-mobile/d4aedf536d035bf4eeab7a7a6e18b73d154d0ea5/LICENSE -o "$task_root/android/app/src/main/assets/LICENSE.node.txt"
printf 'Gradle: %s/gradle-8.13/bin/gradle\n' "$task_tools"
