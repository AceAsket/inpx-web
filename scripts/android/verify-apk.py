#!/usr/bin/env python3
"""Check the packaged ABI, manifest, runtime and update-compatible certificate."""
import argparse
import hashlib
import io
import json
import os
import pathlib
import re
import struct
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("apk", type=pathlib.Path)
parser.add_argument("--abi", required=True, choices=["armeabi-v7a", "arm64-v8a"])
parser.add_argument("--backend", required=True)
parser.add_argument("--source", required=True)
parser.add_argument("--certificate")
args = parser.parse_args()
tools = pathlib.Path(os.environ.get("INPX_ANDROID_TOOLS", pathlib.Path.home() / ".cache/inpx-android"))
sdk = tools / "sdk/build-tools/36.0.0"
badging = subprocess.check_output([str(sdk / "aapt"), "dump", "badging", str(args.apk)], text=True)
package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
assert package and package[1] == "ru.inpx.server", "Wrong Android application ID"
assert "sdkVersion:'28'" in badging and "targetSdkVersion:'36'" in badging
gradle = pathlib.Path("android/app/build.gradle").read_text()
assert package[2] == re.search(r"versionCode (\d+)", gradle)[1], "Stale version code"
assert package[3] == re.search(r"versionName '([^']+)'", gradle)[1], "Stale version name"
certificate_info = subprocess.check_output([str(sdk / "apksigner"), "verify", "--print-certs", str(args.apk)], text=True)
certificate = re.search(r"certificate SHA-256 digest: ([0-9a-fA-F]+)", certificate_info)[1].lower()
if args.certificate:
    expected_certificate = args.certificate.strip().lower()
    assert certificate == expected_certificate, f"APK certificate {certificate} differs from previous server {expected_certificate}"
with zipfile.ZipFile(args.apk) as apk:
    names = apk.namelist()
    abis = {name.split("/")[1] for name in names if name.startswith("lib/") and name.endswith(".so")}
    assert abis == {args.abi}, f"Unexpected packaged ABIs: {abis}"
    required = {"libnode.so", "libinpxbridge.so", "lib7zz.so", "libfbc.so", "libmutool.so", "libkindling.so"}
    assert required <= {pathlib.PurePosixPath(name).name for name in names if name.startswith("lib/")}
    for name in names:
        if name.startswith("lib/") and name.endswith(".so"):
            with apk.open(name) as source:
                header = source.read(20)
            assert header[:4] == b"\x7fELF" and header[5] == 1, name
            expected_class, expected_machine = (1, 40) if args.abi == "armeabi-v7a" else (2, 183)
            assert header[4] == expected_class and struct.unpack("<H", header[18:20])[0] == expected_machine, name
    runtime = apk.read("assets/runtime.zip")
    runtime_hash = hashlib.sha256(runtime).hexdigest()
    assert runtime_hash == apk.read("assets/runtime.sha256").decode().strip()
    with zipfile.ZipFile(io.BytesIO(runtime)) as contents:
        manifest = json.loads(contents.read("runtime-manifest.json"))
        assert manifest["backendVersion"] == args.backend
        assert manifest["sourceCommit"] == args.source
        assert json.loads(contents.read("package.json"))["version"] == args.backend
        assert contents.read("server/config/application_env").decode().strip() == "production"
        for name in manifest["backendPackages"]:
            assert f"node_modules/{name}/package.json" in contents.namelist(), f"Missing backend package: {name}"
        for name in ["sax", "qrcode", "@streamparser/json-node"]:
            assert name in manifest["backendPackages"], f"Missing current backend dependency: {name}"
        assert "dist/public.json" in contents.namelist()
with args.apk.open("rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
report = dict(name=args.apk.name, abi=args.abi, bytes=args.apk.stat().st_size, sha256=digest,
              applicationId=package[1], versionCode=int(package[2]), versionName=package[3],
              signingCertificateSha256=certificate, backendVersion=args.backend, sourceCommit=args.source,
              runtimeSha256=runtime_hash, nodeVersion=manifest["nodeVersion"], deviceTested=False)
args.apk.with_suffix(".metadata.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
