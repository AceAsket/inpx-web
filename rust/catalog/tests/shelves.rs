use std::collections::HashMap;

use inpx_catalog::{Book, Catalog, ShelfRequest, build};

const DAY: i64 = 86_400_000;

fn book(id: u64, date: Option<i64>, rating: i32) -> Book {
    Book {
        id,
        uid: format!("book-{id}"),
        copy_key: format!("copy-{id}"),
        quality: 10.0,
        date_ms: date,
        date_order: 1,
        rating,
        author_order: 0,
        title_order: id as u32,
        author_group: String::new(),
        series_group: String::new(),
    }
}

fn request() -> ShelfRequest {
    ShelfRequest {
        generation: "fixture-v1".into(),
        now_ms: 0,
        days_windows: vec![0, 1],
        newest_limit: 3,
        popular_limit: 0,
        scores: HashMap::new(),
    }
}

#[test]
fn newer_windows_exclude_prior_picks_before_resolving_copies() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("catalog.redb");
    let first = book(1, Some(0), 5);
    let mut second = book(2, Some(-DAY), 4);
    second.copy_key.clone_from(&first.copy_key);
    second.quality = 20.0;
    let lower_boundary = book(3, Some(-2 * DAY + 1), 3);
    let future = book(4, Some(1), 5);
    let too_old = book(5, Some(-2 * DAY), 5);
    build(
        &path,
        "fixture-v1",
        [first, second, lower_boundary, future, too_old].map(Ok),
    )
    .unwrap();
    let found = Catalog::open(&path).unwrap().shelves(&request()).unwrap();
    assert_eq!(found, vec![vec!["book-1"], vec!["book-2", "book-3"]]);
}

#[test]
fn activity_ranks_winning_copies_then_fills_from_ratings_with_diversity() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("catalog.redb");
    let mut low_copy = book(1, None, 0);
    let mut better_copy = book(2, None, 5);
    better_copy.quality = 11.0;
    low_copy.copy_key.clone_from(&better_copy.copy_key);
    let mut active = book(3, None, 0);
    active.author_group = "author".into();
    let mut rated = book(4, None, 4);
    rated.author_group = "author".into();
    let mut third_same_author = book(5, None, 3);
    third_same_author.author_group = "author".into();
    let remaining = book(6, None, 1);
    build(
        &path,
        "fixture-v1",
        [
            low_copy,
            better_copy,
            active,
            rated,
            third_same_author,
            remaining,
        ]
        .map(Ok),
    )
    .unwrap();
    let mut query = request();
    query.days_windows.clear();
    query.popular_limit = 5;
    query.scores = [("book-1".into(), 999), ("book-3".into(), 20)].into();
    let found = Catalog::open(&path).unwrap().shelves(&query).unwrap();
    assert_eq!(found, vec![vec!["book-3", "book-2", "book-4", "book-6"]]);
}

#[test]
fn failed_publication_leaves_the_active_catalog_and_generation_intact() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("catalog.redb");
    let invalid = [Ok(book(1, None, 1)), Ok(book(1, None, 3))];
    assert!(build(&path, "fixture-v1", invalid).is_err());
    assert!(!path.exists());
    assert_eq!(folder.path().read_dir().unwrap().count(), 0);
    build(&path, "fixture-v1", [Ok(book(1, None, 1))]).unwrap();
    assert!(build(&path, "fixture-v2", [Ok(book(2, None, 1))]).is_err());
    let catalog = Catalog::open(&path).unwrap();
    let mut query = request();
    query.days_windows.clear();
    query.popular_limit = 1;
    assert_eq!(catalog.shelves(&query).unwrap(), vec![vec!["book-1"]]);
    query.generation = "fixture-v2".into();
    assert!(catalog.shelves(&query).is_err());
}
