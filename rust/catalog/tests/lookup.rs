use inpx_catalog::{LookupIndex, build_lookup};
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
