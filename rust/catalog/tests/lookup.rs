use inpx_catalog::{LookupIndex, build_lookup, seal_lookup};
use serde_json::{Value, json};
use tempfile::tempdir;

#[test]
fn lookup_preserves_order_and_samples_without_expand() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("lookup.redb");
    let rows = [
        json!({"table":"word","id":0,"name":"author:толст","bookIds":[9,3,4,12,5,22,1]}),
        json!({"table":"word","id":1,"name":"author:толстой","bookIds":[12,2,18,5]}),
        json!({"table":"word","id":2,"name":"author:лев","bookIds":[5,9,18]}),
        json!({"table":"author","id":1,"name":"Толстой Лев","count":3,"bookIds":[5,9,18]}),
    ];
    assert_eq!(
        build_lookup(
            &path,
            "active",
            4,
            false,
            rows.into_iter().map(|row| Ok(serde_json::from_value(row)?))
        )
        .unwrap(),
        4
    );
    let index = LookupIndex::open(&path).unwrap();
    let query = |value: Value| index.query(serde_json::from_value(value).unwrap());
    let books =
        query(json!({"generation":"active","op":"books","table":"word","groups":[[0,1],[2]]}))
            .unwrap();
    assert_eq!(serde_json::to_value(books).unwrap(), json!([9, 5, 18]));
    let samples =
        query(json!({"generation":"active","op":"sample","table":"word","ids":[2,0]})).unwrap();
    assert_eq!(
        serde_json::to_value(samples).unwrap(),
        json!([
            {"id":2,"name":"author:лев","count":0,"bookIds":[5,9,18],"complete":true},
            {"id":0,"name":"author:толст","count":0,"bookIds":[9,4,5,1],"complete":false}
        ])
    );
    let exact =
        query(json!({"generation":"active","op":"books","table":"author","groups":[[1]]})).unwrap();
    assert_eq!(serde_json::to_value(exact).unwrap(), json!([5, 9, 18]));
    let labels =
        query(json!({"generation":"active","op":"labels","table":"author","ids":[1]})).unwrap();
    assert_eq!(
        serde_json::to_value(labels).unwrap(),
        json!(["Толстой Лев"])
    );
    assert!(query(json!({"generation":"stale","op":"sample","table":"word","ids":[2]})).is_err());
    assert!(
        query(json!({"generation":"active","op":"books","table":"word","groups":[[3]]})).is_err()
    );
}

#[test]
fn incomplete_lookup_is_never_published() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("lookup.redb");
    assert!(build_lookup(&path, "active", 1, true, []).is_err());
    assert!(!path.exists());
    assert!(!dir.path().join("author_id.map").exists());
    assert!(build_lookup(&path, "active", 0, false, []).is_ok());
    assert!(build_lookup(&path, "another", 0, false, []).is_err());
}

#[test]
fn builds_compatible_book_maps_from_the_same_postings() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("lookup.redb");
    let rows = [
        json!({"table":"author","id":1,"name":"author one","bookIds":[1,5]}),
        json!({"table":"author","id":2,"name":"author two","bookIds":[5]}),
        json!({"table":"series","id":4,"name":"?","bookIds":[2],"omitFromBookMap":true}),
        json!({"table":"series","id":5,"name":"series","bookIds":[3]}),
    ];
    build_lookup(
        &path,
        "active",
        4,
        true,
        rows.into_iter().map(|row| Ok(serde_json::from_value(row)?)),
    )
    .unwrap();
    let load = |name| {
        serde_json::from_slice::<Value>(&std::fs::read(dir.path().join(name)).unwrap()).unwrap()
    };
    assert_eq!(
        load("author_id.map"),
        json!({"arr":[null,1,null,null,null,0],"map":[[5,[1,2]]]})
    );
    assert_eq!(
        load("series_id.map"),
        json!({"arr":[null,null,null,5],"map":[]})
    );
    assert_eq!(load("title_id.map"), json!({"arr":[],"map":[]}));
}
#[test]
fn label_order_and_counts_can_be_read_without_compatibility_files() {
    let dir = tempdir().unwrap();
    let old = dir.path().join("author");
    std::fs::create_dir(&old).unwrap();
    std::fs::write(old.join("meta.0"),r#"1{"index":[{"field":"value","type":"string","unique":true,"depth":1000000,"fileName":"index1"}]}"#).unwrap();
    std::fs::write(
        old.join("index1.0"),
        r#"1{"hash":[["é",2],["e",1]],"sorted":[["e","é"]],"delCount":0}"#,
    )
    .unwrap();
    let file = dir.path().join("lookup.redb");
    let rows = [json!({"table":"author","id":1,"name":"E","count":3,"deleted":2,"bookIds":[7]})];
    build_lookup(
        &file,
        "current",
        1,
        false,
        rows.into_iter().map(|row| Ok(serde_json::from_value(row)?)),
    )
    .unwrap();
    assert_eq!(seal_lookup(&file, "current").unwrap(), 1);
    std::fs::rename(old, dir.path().join("backup")).unwrap();
    let index = LookupIndex::open(&file).unwrap();
    let get = |op| {
        serde_json::to_value(index.query(serde_json::from_value(op).unwrap()).unwrap()).unwrap()
    };
    assert_eq!(
        get(json!({"generation":"current","op":"order","table":"author"})),
        json!({"labels":[[2,"é"],[1,"e"]],"runs":[[1,0]]})
    );
    assert_eq!(
        get(json!({"generation":"current","op":"nameRows","table":"author","ids":[1]})),
        json!([{"id":1,"name":"E","bookCount":3,"bookDelCount":2}])
    );
}

#[test]
fn native_name_windows_keep_run_merge_order_and_book_intersection() {
    let dir = tempdir().unwrap();
    let old = dir.path().join("title");
    std::fs::create_dir(&old).unwrap();
    std::fs::write(old.join("meta.0"),r#"1{"index":[{"field":"value","type":"string","unique":true,"depth":1000000,"fileName":"index1"}]}"#).unwrap();
    std::fs::write(old.join("index1.0"),r#"1{"hash":[["?",1],["apple",2],["[apple]",3],["яблоко apple",4]],"sorted":[["?"],["[apple]","apple","яблоко apple"]],"delCount":0}"#).unwrap();
    let file = dir.path().join("lookup.redb");
    let rows = [
        (1, vec![9, 1]),
        (2, vec![4, 5]),
        (3, vec![6, 1]),
        (4, vec![9, 5]),
    ];
    build_lookup(
        &file,
        "test",
        4,
        false,
        rows.into_iter().map(|(id, books)| {
            Ok(serde_json::from_value(json!({
                "table":"title","id":id,"name":id.to_string(),"bookIds":books,
            }))?)
        }),
    )
    .unwrap();
    seal_lookup(&file, "test").unwrap();
    let index = LookupIndex::open(&file).unwrap();
    let get = |op| {
        serde_json::to_value(index.query(serde_json::from_value(op).unwrap()).unwrap()).unwrap()
    };
    let windows = json!({"kind":"windows","ranges":[[[0,1],[0,2]]]});
    let contains = json!({"kind":"contains","text":"apple"});
    assert_eq!(
        get(json!({"generation":"test","op":"probe","capabilities":true})),
        json!({"nameRanges":true})
    );
    assert_eq!(
        get(json!({"generation":"test","op":"nameSlices","table":"title","windows":[[1,0,2]]})),
        json!([["[apple]", "apple"]])
    );
    assert_eq!(
        get(json!({"generation":"test","op":"selectNames","table":"title","selection":windows})),
        json!([3, 2, 1])
    );
    assert_eq!(
        get(
            json!({"generation":"test","op":"selectNameBooks","table":"title","selections":[windows,contains]})
        ),
        json!([6, 1, 4, 5, 9])
    );
    assert_eq!(
        get(
            json!({"generation":"test","op":"selectNames","table":"title","selection":{"kind":"contains","text":"apple","symbol":true}})
        ),
        json!([3])
    );
}
