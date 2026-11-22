#!/usr/bin/env python3
"""Verify the Rust-only preview's package, architecture, assets and signing key."""
import argparse
import hashlib
import io
import json
import pathlib
import re
import struct
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("apk", type=pathlib.Path)
parser.add_argument("--abi", required=True, choices=["arm64-v8a", "armeabi-v7a"])
parser.add_argument("--source", required=True)
args = parser.parse_args()
tools = pathlib.Path.home() / ".cache/inpx-android/sdk/build-tools/36.0.0"
badging = subprocess.check_output([str(tools / "aapt"), "dump", "badging", str(args.apk)], text=True)
assert "package: name='ru.inpx.server.rust'" in badging
assert "sdkVersion:'28'" in badging
assert "versionName='0.8.0-rust-preview'" in badging
assert f"native-code: '{args.abi}'" in badging

with zipfile.ZipFile(args.apk) as archive:
    native = [name for name in archive.namelist() if name.startswith("lib/") and name.endswith(".so")]
    assert native == [f"lib/{args.abi}/libinpxserver.so"], native
    elf = archive.read(native[0])
    assert elf[:4] == b"\x7fELF"
    assert struct.unpack_from("<H", elf, 18)[0] == (183 if args.abi == "arm64-v8a" else 40)
    wide = elf[4] == 2
    offset = struct.unpack_from("<Q" if wide else "<I", elf, 32 if wide else 28)[0]
    stride, count = struct.unpack_from("<HH", elf, 54 if wide else 42)
    for index in range(count):
        header = offset + index * stride
        if struct.unpack_from("<I", elf, header)[0] == 1:
            alignment = struct.unpack_from("<Q" if wide else "<I", elf, header + (48 if wide else 28))[0]
            assert alignment >= 16384, alignment
    runtime = archive.read("assets/runtime.zip")
    assert hashlib.sha256(runtime).hexdigest() == archive.read("assets/runtime.sha256").decode().strip()
    with zipfile.ZipFile(io.BytesIO(runtime)) as assets:
        manifest = json.loads(assets.read("runtime-manifest.json"))
        assert manifest["runtime"] == "rust"
        assert manifest["sourceCommit"] == args.source
        assert {"demo/demo.inpx", "demo/books.zip", "demo/books.7z", "public.json"} <= set(assets.namelist())
        assert not any(name.startswith(("node_modules/", "server/")) for name in assets.namelist())

signed = subprocess.check_output([str(tools / "apksigner"), "verify", "--print-certs", str(args.apk)], text=True)
certificate = re.search(r"certificate SHA-256 digest: ([0-9a-f]+)", signed)[1]
assert certificate == pathlib.Path("android/signing-certificate.sha256").read_text().strip()
metadata = dict(name=args.apk.name, abi=args.abi, applicationId="ru.inpx.server.rust", backend=manifest,
                bytes=args.apk.stat().st_size, sha256=hashlib.sha256(args.apk.read_bytes()).hexdigest(),
                signingCertificateSha256=certificate)
args.apk.with_suffix(".metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(json.dumps(metadata))
