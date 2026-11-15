mod book_maps;
mod catalog_postings;
mod catalog_text;
mod catalog_update;
mod index;
mod jemba;
mod jemba_identity;
mod lookup;
mod shelves;
mod store;

pub use catalog_update::{UpdateRequest, prepare_update};
pub use index::{Book, Catalog, build};
pub use jemba::{build_book_table, build_index_table, build_number_index_table};
pub use jemba_identity::read_book_identities;
pub use lookup::{LookupIndex, LookupRequest, build_lookup};
pub use shelves::ShelfRequest;
pub use store::{BookStore, build_store};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
