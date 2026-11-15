use std::env;
use std::ffi::OsString;
use std::io::{self, BufRead, BufWriter, Write};
use std::path::Path;
use std::process::ExitCode;

use inpx_catalog::{
    BookStore, Catalog, LookupIndex, Result, ShelfRequest, build, build_book_table,
    build_index_table, build_lookup, build_number_index_table, build_store, prepare_update,
    read_book_identities,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize)]
struct Header {
    generation: String,
    rows: Option<u64>,
    #[serde(default, rename = "bookMaps")]
    book_maps: bool,
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
    const USAGE: &str = "usage: inpx-catalog <build|shelves|build-lookup|lookup|build-book|build-index|build-number-index|book-identities|build-store|store|prepare-update> <path>";
    let [command, path] = args else {
        return Err(USAGE.into());
    };
    let input = io::stdin().lock();
    let path = Path::new(path);
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
            build_lookup(
                path,
                &header.generation,
                header.rows.ok_or("missing lookup row count")?,
                header.book_maps,
                lines.map(|line| Ok(serde_json::from_str(&line?)?)),
            )?
        };
        println!("{}", json!({"indexed": records}));
    } else if command == "shelves" {
        let request: ShelfRequest = serde_json::from_reader(input)?;
        let windows = Catalog::open(path)?.shelves(&request)?;
        println!("{}", json!(windows));
    } else if command == "lookup" {
        let index = LookupIndex::open(path)?;
        serve(input, |request| index.query(request))?;
    } else if command == "store" {
        let store = BookStore::open(path)?;
        serve(input, |request| store.query(request))?;
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
