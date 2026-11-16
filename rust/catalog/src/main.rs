use std::env;
use std::ffi::OsString;
use std::io::{self, BufRead, BufWriter, Write};
use std::path::Path;
use std::process::ExitCode;

use inpx_catalog::{
    BookStore, Catalog, LookupIndex, Result, ShelfRequest, build, build_book_table,
    build_index_table, build_lookup_with_cache, build_number_index_table, build_store,
    prepare_update, read_book_identities, seal_book_order, seal_lookup,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize)]
struct Header {
    generation: String,
    rows: Option<u64>,
    #[serde(default, rename = "bookMaps")]
    book_maps: bool,
    #[serde(rename = "bookStoreGeneration")]
    book_store_generation: Option<String>,
    #[serde(default, rename = "lowMemory")]
    low_memory: bool,
}

#[derive(Deserialize)]
struct Message<T> {
    id: u64,
    #[serde(flatten)]
    request: T,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Reply<T> {
    Result(T),
    Error(String),
}

#[derive(Serialize)]
struct Response<T> {
    id: u64,
    #[serde(flatten)]
    reply: Reply<T>,
}

fn serve<Q: serde::de::DeserializeOwned, R: Serialize>(
    input: impl BufRead,
    query: impl Fn(Q) -> Result<R>,
) -> Result<()> {
    let mut output = BufWriter::new(io::stdout().lock());
    for line in input.lines() {
        let Message { id, request } = serde_json::from_str(&line?)?;
        let reply = match query(request) {
            Ok(value) => Reply::Result(value),
            Err(error) => Reply::Error(error.to_string()),
        };
        serde_json::to_writer(&mut output, &Response { id, reply })?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

fn run(args: &[OsString]) -> Result<()> {
    if let [command] = args
        && command == "load-config"
    {
        let options = serde_json::from_reader(io::stdin().lock())
            .map_err(|_| "Invalid configuration load request")?;
        let result = inpx_catalog::configuration::load(options)?;
        serde_json::to_writer(io::stdout().lock(), &result)?;
        return Ok(());
    }
    if let [command] = args
        && command == "save-config"
    {
        let saved = inpx_catalog::configuration::save_from(io::stdin().lock())?;
        println!("{}", json!({ "saved": saved }));
        return Ok(());
    }
    if let [command] = args
        && command == "install-web-app"
    {
        let options = serde_json::from_reader(io::stdin().lock())?;
        inpx_catalog::web_app::install(options)?;
        println!("{}", json!({ "installed": true }));
        return Ok(());
    }
    if let [command] = args
        && command == "library-sources"
    {
        let options = serde_json::from_reader(io::stdin().lock())?;
        let sources = inpx_catalog::library_sources::resolve(options)?;
        println!("{}", json!({ "sources": sources }));
        return Ok(());
    }
    if let [command, data, config, version] = args
        && command == "upgrade-snapshot"
    {
        let version = version.to_str().ok_or("invalid upgrade version")?;
        let result =
            inpx_catalog::upgrade_data::snapshot(Path::new(data), Path::new(config), version)?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    if let [command, destination, source, config] = args
        && command == "migrate-data"
    {
        let directory = inpx_catalog::upgrade_data::migrate(
            Path::new(destination),
            Path::new(source),
            Path::new(config),
        )?;
        println!("{}", json!({ "directory": directory }));
        return Ok(());
    }
    const USAGE: &str = "usage: inpx-catalog <build|shelves|serve-shelves|build-lookup|publish-lookup|seal-lookup|lookup|build-book|build-index|build-number-index|book-identities|build-store|store|count-book-files|folder-inventory|folder-index|publish-folder-cache|prepare-update|catalogue-lock|service-cache|access-store|progress-journal|backup-zip|backup-vault|book-archive|book-batch|book-cache|directory-diagnostics|isbn-store|credentials|kosync> <path>";
    let [command, path] = args else {
        return Err(USAGE.into());
    };
    let path = Path::new(path);
    let input = io::stdin().lock();
    if command == "build" || command == "build-lookup" {
        let mut lines = input.lines();
        let first = lines.next().ok_or("missing catalog header")??;
        let header: Header = serde_json::from_str(&first)?;
        let records = if command == "build" {
            build(
                path,
                &header.generation,
                lines.map(|line| Ok(serde_json::from_str(&line?)?)),
            )?
        } else {
            build_lookup_with_cache(
                path,
                &header.generation,
                header.rows.ok_or("missing lookup row count")?,
                header.book_maps,
                header.low_memory,
                lines.map(|line| Ok(serde_json::from_str(&line?)?)),
            )?
        };
        println!("{}", json!({"indexed": records}));
    } else if command == "publish-lookup" {
        let records = inpx_catalog::lookup_staging::publish(path, input)?;
        println!("{}", json!({"indexed": records}));
    } else if command == "shelves" {
        let request: ShelfRequest = serde_json::from_reader(input)?;
        let windows = Catalog::open(path)?.shelves(&request)?;
        println!("{}", json!(windows));
    } else if command == "serve-shelves" {
        let index = Catalog::open(path)?;
        serve(input, |request| index.shelves(&request))?;
    } else if command == "lookup" {
        let index = LookupIndex::open(path)?;
        serve(input, |request| index.query(request))?;
    } else if command == "seal-lookup" {
        let header: Header = serde_json::from_reader(input)?;
        let ordered = seal_lookup(path, &header.generation)?;
        if let Some(generation) = header.book_store_generation {
            seal_book_order(
                path.parent().ok_or("missing catalogue directory")?,
                &generation,
            )?;
        }
        println!("{}", json!({"orderedTables":ordered}));
    } else if command == "store" {
        let store = BookStore::open(path)?;
        serve(input, |request| store.query(request))?;
    } else if command == "count-book-files" {
        #[derive(Deserialize)]
        struct CountsRequest {
            generation: String,
        }
        let store = BookStore::open_low_memory(path)?;
        serve(input, |request: CountsRequest| {
            store.count_files(&request.generation)
        })?;
    } else if command == "folder-inventory" {
        inpx_catalog::folder_inventory::write_inventory(
            path,
            BufWriter::with_capacity(128 * 1024, io::stdout().lock()),
        )?;
    } else if command == "folder-index" {
        inpx_catalog::folder_index::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "publish-folder-cache" {
        inpx_catalog::folder_index::publish_staged(path)?;
    } else if command == "catalogue-lock" {
        inpx_catalog::catalogue_lock::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "service-cache" {
        let cache = inpx_catalog::service_cache::ServiceCache::open(path)?;
        serve(input, |request| cache.query(request))?;
    } else if command == "access-store" {
        inpx_catalog::access_store::serve(
            path,
            input,
            BufWriter::with_capacity(128 * 1024, io::stdout().lock()),
        )?;
    } else if command == "progress-journal" {
        let journal = inpx_catalog::progress_journal::ProgressJournal::new(path);
        serve(input, |request| journal.query(request))?;
    } else if command == "backup-zip" {
        inpx_catalog::backup_archive::serve(
            input,
            BufWriter::with_capacity(128 * 1024, io::stdout().lock()),
        )?;
    } else if command == "backup-vault" {
        let vault = inpx_catalog::backup_vault::Vault::new(path);
        serve(input, |request| Ok(vault.query(request)))?;
    } else if command == "credentials" {
        inpx_catalog::credentials::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "book-archive" {
        inpx_catalog::book_archive::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "book-batch" {
        inpx_catalog::book_batch::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "book-cache" {
        inpx_catalog::book_cache::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "directory-diagnostics" {
        inpx_catalog::directory_diagnostics::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "kosync" {
        inpx_catalog::kosync::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "isbn-store" {
        inpx_catalog::isbn_store::serve(input, BufWriter::new(io::stdout().lock()))?;
    } else if command == "build-store" {
        let count = build_store(path, input, io::stdout().lock())?;
        println!("{}", json!({"records": count}));
    } else if command == "build-book" {
        let count = build_book_table(path, input, io::stdout().lock())?;
        println!("{}", json!({"records": count}));
    } else if command == "build-index" {
        let count = build_index_table(path, input, io::stdout().lock())?;
        println!("{}", json!({"records": count}));
    } else if command == "build-number-index" {
        let count = build_number_index_table(path, input, io::stdout().lock())?;
        println!("{}", json!({"records": count}));
    } else if command == "book-identities" {
        read_book_identities(
            path,
            BufWriter::with_capacity(128 * 1024, io::stdout().lock()),
        )?;
    } else if command == "prepare-update" {
        let request = serde_json::from_reader(input)?;
        let summary = prepare_update(path, &request, io::stdout().lock())?;
        println!("{}", json!({"summary":summary}));
    } else {
        return Err(USAGE.into());
    }
    Ok(())
}

fn main() -> ExitCode {
    match run(&env::args_os().skip(1).collect::<Vec<_>>()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("inpx-catalog: {error}");
            ExitCode::FAILURE
        }
    }
}
