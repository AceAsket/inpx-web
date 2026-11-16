use std::fs::File;
use std::path::Path;

fn main() {
    let manifest = Path::new("../../package.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let version = File::open(manifest)
        .ok()
        .and_then(|file| serde_json::from_reader::<_, serde_json::Value>(file).ok())
        .and_then(|manifest| manifest.get("version")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into());
    println!("cargo:rustc-env=INPX_RELEASE_VERSION={version}");
}
