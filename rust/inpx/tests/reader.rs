use std::io::{self, Cursor, Write};

use inpx_reader::Archive;
use serde_json::json;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn index(entries: &[(&str, &[u8])]) -> Cursor<Vec<u8>> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for &(name, bytes) in entries {
        zip.start_file(name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap()
}

#[test]
fn keeps_archive_order_custom_fields_and_record_ids() {
    let line = " Толстой, Лев :Тургенев:\x04:prose::classic:\x04Книга\x04 -42mb\x041880\x04";
    let second = "\x04sf:\x04Другая\x04+15\x042000\x04explicit.7z";
    let content = format!("{line}\r\n\n{second}");
    let mut first = Archive::open(index(&[
        (
            "structure.info",
            b"\xef\xbb\xbfAUTHOR;GENRE;TITLE;SIZE;YEAR;FOLDER; \r\n",
        ),
        ("metadata.inp", b"\x04\x04Earlier entry\n"),
        ("nested/file.inp", content.as_bytes()),
        ("ignored.INP", b"Not part of the catalog"),
    ]))
    .unwrap();
    assert_eq!(
        first.info().structure,
        "AUTHOR;GENRE;TITLE;SIZE;YEAR;FOLDER;"
    );
    assert_eq!(
        serde_json::to_value(&first.info().rec_struct).unwrap(),
        json!([
            {"field":"author","type":"S"}, {"field":"genre","type":"S"},
            {"field":"title","type":"S"}, {"field":"size","type":"N"},
            {"field":"folder","type":"S"},
        ]),
    );
    let mut records = Vec::new();
    assert_eq!(
        first
            .records(|row| {
                records.push(row);
                Ok(())
            })
            .unwrap(),
        3
    );
    assert_eq!(records[0]["title"], "Earlier entry");
    assert_eq!(records[1]["author"], "Толстой  Лев,Тургенев");
    assert_eq!(records[1]["genre"], "prose,classic");
    assert_eq!(records[1]["folder"], "file.zip");
    assert_eq!(records[1]["year"], "1880");
    assert_eq!(records[1]["size"], -42);
    assert_eq!(records[1]["del"], 0);
    assert_eq!(records[2]["folder"], "explicit.7z");
    assert_eq!(records[2]["size"], 15);

    let mut copy = Archive::open(index(&[
        ("structure.info", b"AUTHOR;GENRE;TITLE;SIZE;YEAR;FOLDER;"),
        ("different.inp", line.as_bytes()),
    ]))
    .unwrap();
    copy.records(|row| {
        assert_eq!(row["_uid"], records[1]["_uid"]);
        assert_eq!(row["folder"], "different.zip");
        Ok(())
    })
    .unwrap();
}

#[test]
fn falls_back_to_legacy_structure_and_decodes_non_utf8_rows() {
    let mut archive = Archive::open(index(&[(
        "books.inp",
        b"Name:\x04sf:\x04\xff\xf0\x9f\x92\n",
    )]))
    .unwrap();
    assert_eq!(archive.info().collection, "");
    assert!(archive.info().structure.contains("KEYWORDS"));
    assert_eq!(archive.info().rec_struct.last().unwrap().field, "folder");
    assert_eq!(
        archive
            .records(|row| {
                assert_eq!(row["title"], "\u{fffd}\u{fffd}");
                assert_eq!(row["folder"], "books.zip");
                Ok(())
            })
            .unwrap(),
        1
    );
}

#[test]
fn reads_lightlib_numbered_fields_and_preserves_the_file_identity() {
    let mut archive = Archive::open(index(&[
        ("structure.info", b"\xef\xbb\xbf0 TITLE;\r\n2 RATE;\r\n1 FILE;\r\n3 PAGES; // a;b;c\r\n4 PUBLISHER;\r\n5 ISBN;\r\n6 KEYWORD;"),
        ("version.inf", b"20261101\r\n"),
        ("books.inp", b"Volume\x040012\x045\x04210\x04Pub;City;1994\x04978-0-306-40615-7\x04space, travel\r\n"),
    ])).unwrap();
    assert_eq!(archive.info().version, "20261101");
    archive
        .records(|book| {
            assert_eq!(book["title"], "Volume");
            assert_eq!(book["file"], "0012");
            assert_eq!(book["libid"], "0012");
            assert_eq!(book["librate"], 5);
            assert_eq!(book["pages"], "210");
            assert_eq!(book["publisher"], "Pub;City;1994");
            assert_eq!(book["isbn"], "978-0-306-40615-7");
            assert_eq!(book["keywords"], "space, travel");
            assert_eq!(book["folder"], "books.zip");
            Ok(())
        })
        .unwrap();
}

#[test]
fn propagates_a_stopped_consumer() {
    let mut archive = Archive::open(index(&[("books.inp", b"one\ntwo")])).unwrap();
    let mut visits = 0;
    let error = archive
        .records(|_| {
            visits += 1;
            Err(io::ErrorKind::BrokenPipe.into())
        })
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    assert_eq!(visits, 1);
}
