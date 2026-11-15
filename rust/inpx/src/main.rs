use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Write};
use std::process::ExitCode;

use inpx_reader::{Archive, Event, Info, Record};
use serde::Serialize;
use serde_json::json;

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Frame<'a> {
    File(&'a str),
    Records(&'a [Record]),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Header<'a> {
    info: &'a Info,
    total_files: usize,
}

fn line(output: &mut impl Write, frame: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *output, frame)?;
    output.write_all(b"\n")
}

fn flush_batch(output: &mut impl Write, batch: &mut Vec<Record>) -> io::Result<()> {
    if !batch.is_empty() {
        line(output, &Frame::Records(batch))?;
        batch.clear();
    }
    Ok(())
}

fn run(args: &[OsString]) -> Result<(), Box<dyn Error>> {
    let (path, mode) = match args {
        [path] => (path, ""),
        [flag, path] if flag == "--count" => (path, "count"),
        [flag, path] if flag == "--stream" => (path, "stream"),
        _ => return Err("usage: inpx-reader [--count|--stream] <index.inpx>".into()),
    };
    let mut archive = Archive::open(BufReader::new(File::open(path)?))?;
    let mut output = BufWriter::with_capacity(64 * 1024, io::stdout().lock());
    if mode == "count" {
        let count = archive.records(|_| Ok(()))?;
        line(&mut output, &json!({"records": count}))?;
    } else if mode == "stream" {
        line(
            &mut output,
            &Header {
                info: archive.info(),
                total_files: archive.input_files() + 3,
            },
        )?;
        const BATCH_SIZE: usize = 512;
        let mut batch = Vec::with_capacity(BATCH_SIZE);
        archive.scan(|event| {
            match event {
                Event::File(name) => {
                    flush_batch(&mut output, &mut batch)?;
                    line(&mut output, &Frame::File(name))?;
                }
                Event::Record(record) => {
                    batch.push(record);
                    if batch.len() == BATCH_SIZE {
                        flush_batch(&mut output, &mut batch)?;
                    }
                }
            }
            Ok(())
        })?;
        flush_batch(&mut output, &mut batch)?;
    } else {
        line(&mut output, &json!({"info": archive.info()}))?;
        archive.records(|record| line(&mut output, &record))?;
    }
    output.flush()?;
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("inpx-reader: {error}");
            ExitCode::FAILURE
        }
    }
}
