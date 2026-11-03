#!/usr/bin/env python3
"""Publish a new Android-only prerelease after both verified ABI artifacts exist."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

version = os.environ["VERSION"]
source = os.environ["SOURCE_SHA"]
backend = os.environ["BACKEND"]
tag = "android-v" + version
directory = pathlib.Path("release-assets")
reports = [json.loads(file.read_text()) for file in sorted(directory.glob("*.metadata.json"))]
assert len(reports) == 2 and {report["abi"] for report in reports} == {"armeabi-v7a", "arm64-v8a"}
certificate = pathlib.Path("android/signing-certificate.sha256").read_text().strip()
assets = []
for report in reports:
    assert report["sourceCommit"] == source and report["backendVersion"] == backend
    assert report["versionName"] == version + "-prototype"
    assert report["signingCertificateSha256"] == certificate
    apk = directory / report["name"]
    with apk.open("rb") as stream:
        assert hashlib.file_digest(stream, "sha256").hexdigest() == report["sha256"]
    checksum = apk.with_suffix(".apk.sha256")
    assert checksum.read_text().strip().split()[0] == report["sha256"]
    assets.extend([str(apk), str(checksum)])
manifest = directory / (tag + ".json")
manifest.write_text(json.dumps(dict(tag=tag, backendVersion=backend, sourceCommit=source,
                                   signingCertificateSha256=certificate, assets=reports), indent=2) + "\n")
assets.append(str(manifest))
if "--check-only" in sys.argv[1:]:
    print(f"Validated {tag}: matching sources, certificates, both ABIs and artifact checksums")
    raise SystemExit(0)
notes = pathlib.Path("android/releases") / (tag + ".md")
if not notes.exists():
    notes = directory / "release-notes.md"
    notes.write_text(f"Android {version}: ARM32 / ARM64, Android 9+. Backend INPX Web {backend}.\n\n"
                     "Both APKs passed unit tests, Android Lint, ABI/runtime and signing checks. "
                     "No physical-device test is implied by the automatic build. "
                     "The signing certificate is unchanged; install over the previous APK.\n")
existing = subprocess.run(["gh", "release", "view", tag, "--json", "isDraft,targetCommitish"], capture_output=True, text=True)
if existing.returncode == 0:
    data = json.loads(existing.stdout)
    assert data["targetCommitish"] == source, "Version already exists for another source commit; bump the Android version"
    if not data["isDraft"]:
        print(f"{tag} already published for this commit; existing assets preserved")
        raise SystemExit(0)
else:
    subprocess.run(["gh", "release", "create", tag, "--draft", "--prerelease", "--target", source,
                    "--title", f"Android {version} — ARM32 / ARM64, Android 9+", "--notes-file", str(notes)], check=True)
subprocess.run(["gh", "release", "upload", tag, *assets, "--clobber"], check=True)
subprocess.run(["gh", "release", "edit", tag, "--draft=false", "--prerelease"], check=True)
print(f"Published {tag}: two APKs, checksums and verified manifest")
