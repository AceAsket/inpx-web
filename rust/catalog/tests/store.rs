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
