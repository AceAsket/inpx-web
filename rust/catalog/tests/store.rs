use std::path::Path;

use inpx_catalog::{BookStore, build_store};
use serde_json::{Value, json};
use tempfile::tempdir;

fn book(id: u32, uid: &str, title: &str, physical: &str, score: f64, del: u32) -> String {
    json!([
        {"id":id,"_uid":uid,"title":title,"author":"Автор","series":"","serno":0,"del":del,"sourceId":"local"},
        {"words":[["автор","автор"],[],["ёлка","елк"]],"physical":physical,"score":score}
    ])
    .to_string()
}

fn write(directory: &Path, generation: &str, previous: Option<&str>, rows: &[String]) -> bool {
    let header = json!({"generation":generation,"previous":previous});
    let input = format!("{header}\n{}\nfinish {}\n", rows.join("\n"), rows.len());
    build_store(directory, input.as_bytes(), Vec::new()).is_ok()
}

fn query(store: &BookStore, request: Value) -> Value {
    let response = store
        .query(serde_json::from_value(request).unwrap())
        .unwrap();
    serde_json::to_value(response).unwrap()
}

#[test]
fn overlays_update_rows_and_uids_across_generations() {
    let dir = tempdir().unwrap();
    let path = dir.path();
    assert!(write(
        path,
        "base",
        None,
        &[
            book(1, "old", "Старая", "a", 1.0, 0),
            book(2, "reuse", "Исходная", "b", 1.0, 0),
            book(3, "stable", "Третья", "c", 1.0, 0),
        ]
    ));
    assert!(!write(
        path,
        "invalid",
        Some("base"),
        &[book(4, "stable", "Подмена", "d", 1.0, 0),]
    ));
    assert!(write(
        path,
        "first",
        Some("base"),
        &[
            book(1, "new", "Новая", "a", 1.0, 0),
            book(4, "reuse", "Перенос", "d", 1.0, 0),
            "remove 2".into(),
        ]
    ));
    assert!(!write(path, "invalid", Some("base"), &["remove 3".into()]));
    assert!(write(
        path,
        "second",
        Some("first"),
        &[
            "remove 1".into(),
            book(2, "restored", "Возврат", "b", 1.0, 0),
        ]
    ));
    let store = BookStore::open(path).unwrap();
    assert!(
        store
            .query(serde_json::from_value(json!({"generation":"first","op":"probe"})).unwrap())
            .is_err()
    );
    let rows = query(
        &store,
        json!({"generation":"second","op":"rows","ids":[1,2,4,3,90],"fields":["id","_uid"]}),
    );
    assert_eq!(
        rows,
        json!([{"id":2,"_uid":"restored"},{"id":4,"_uid":"reuse"},{"id":3,"_uid":"stable"}])
    );
    let rows = query(
        &store,
        json!({"generation":"second","op":"uids","uids":["old","new","reuse","stable","restored"]}),
    );
    let ids: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, [4, 3, 2]);
    let first = query(
        &store,
        json!({"generation":"second","op":"scan","limit":2,"fields":["id"]}),
    );
    assert_eq!(first, json!({"after":2,"rows":[{"id":2}]}));
    let next = query(
        &store,
        json!({"generation":"second","op":"scan","after":2,"limit":3,"fields":["id"]}),
    );
    assert_eq!(next, json!({"after":null,"rows":[{"id":3},{"id":4}]}));
}

#[test]
fn search_filters_and_picks_the_best_physical_copy() {
    let dir = tempdir().unwrap();
    assert!(write(
        dir.path(),
        "base",
        None,
        &[
            book(1, "one", "Лучшая", "a", 10.0, 0),
            book(2, "two", "Дубль", "a", 2.0, 0),
            book(3, "three", "Удалена", "a", 20.0, 1),
            book(4, "four", "Равная", "a", 10.0, 0),
            book(5, "five", "Другая", "b", 1.0, 0),
        ]
    ));
    let store = BookStore::open(dir.path()).unwrap();
    let result = query(
        &store,
        json!({
            "generation":"base","op":"search","ids":[2,3,4,5,1],
            "terms":[[["авт","авт"]],[],[["е","ел"]]],"deleted":0,"source":"local"
        }),
    );
    let mut matches: Vec<_> = result
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["id"].as_u64().unwrap(),
                row["order"].as_u64().unwrap(),
                row["title"].as_str().unwrap(),
            )
        })
        .collect();
    matches.sort_unstable();
    assert_eq!(matches, [(1, 0, "Лучшая"), (5, 3, "Другая")]);
}

#[test]
fn advanced_filters_keep_the_first_rank_for_merged_copies() {
    let dir = tempdir().unwrap();
    let fixture = |id, source, format, genre, score| {
        let mut row: Value =
            serde_json::from_str(&book(id, &id.to_string(), "Ёлка", source, score, 0)).unwrap();
        row[0]["sourceId"] = json!(source);
        row[0]["ext"] = json!(format);
        row[0]["date"] = json!("2026-02-03");
        row[0]["size"] = json!(100);
        row[0]["genre"] = json!(genre);
        row.to_string()
    };
    assert!(write(
        dir.path(),
        "base",
        None,
        &[
            fixture(1, "main", "fb2", "sf", 1.0),
            fixture(2, "other", "epub", "sf", 8.0),
            fixture(3, "third", "pdf", "sf", 10.0),
            fixture(4, "elsewhere", "fb2", "news", 12.0),
        ]
    ));
    let store = BookStore::open(dir.path()).unwrap();
    let rows = query(
        &store,
        json!({"generation":"base","op":"search","ids":[1,2,3,4],"terms":[[],[],[]],"copies":"merge",
        "filters":[{"kind":"date","from":"2026-01-01","to":"2026-12-31"},{"kind":"numberRange","field":"size","from":10,"to":100},
        {"kind":"genre","values":["sf"]},{"kind":"textValues","field":"ext","values":["fb2","epub"]}]}),
    );
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["id"], 2);
    assert_eq!(rows[0]["order"], 0);
}

#[test]
fn wide_search_uses_the_published_order_after_overlay_changes() {
    let dir = tempdir().unwrap();
    let path = dir.path();
    assert!(write(
        path,
        "base",
        None,
        &[
            book(1, "first", "Первая", "a", 1.0, 0),
            book(2, "best", "Четвёртая", "a", 2.0, 0),
            book(3, "gone", "Третья", "c", 8.0, 0),
            book(4, "last", "Четвёртая", "b", 1.0, 0),
        ]
    ));
    assert!(write(
        path,
        "active",
        Some("base"),
        &["remove 3".into(), book(5, "new", "Новая", "c", 1.0, 1)]
    ));
    let key = "a".repeat(64);
    let mut data = b"INPXORD1active".to_vec();
    for (id, rank, ordinal, deleted) in [
        (1u32, 1u32, 0u32, 0.0f64),
        (2, 1, 2, 0.0),
        (4, 1, 1, 0.0),
        (5, 0, 3, 1.0),
    ] {
        for field in [id, rank, 0, 0, ordinal] {
            data.extend(field.to_le_bytes());
        }
        data.extend(0.0f64.to_le_bytes());
        data.extend(deleted.to_le_bytes());
    }
    std::fs::write(path.join(format!("book-order-{key}.bin")), data).unwrap();
    let store = BookStore::open(path).unwrap();
    let wide = |limit, copies| {
        query(
            &store,
            json!({"generation":"active","op":"wideSearch","orderKey":key,"limit":limit,
        "terms":[[],[],[]],"copies":copies,"filters":[{"kind":"numberValues","field":"del","values":[0]}]}),
        )
    };
    assert_eq!(wide(1, "physical"), json!({"ids":[2],"totalFound":2}));
    assert_eq!(wide(0, "physical"), json!({"ids":[2,4],"totalFound":2}));
    assert_eq!(wide(0, "ranked"), json!({"ids":[2],"totalFound":1}));
}
