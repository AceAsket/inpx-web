use serde_json::{Value, json};

use super::{ReaderState, library, shelves};
use crate::Result;
use crate::profile_login::{BrowserProfile, BrowserProfiles};
use crate::standalone_catalogue::Catalogue;

pub struct PublishedReading {
    data: Value,
    profiles: Vec<BrowserProfile>,
}

impl ReaderState {
    pub fn published_reading(
        &self,
        authorized_stamp: &str,
        profiles: BrowserProfiles,
    ) -> Result<PublishedReading> {
        if profiles.stamp != authorized_stamp {
            return Err("Состояние профилей OPDS изменилось, повторите запрос".into());
        }
        let data = self.snapshot(authorized_stamp)?.data;
        Ok(PublishedReading {
            data,
            profiles: profiles
                .users
                .into_iter()
                .filter(|user| user.opds_enabled)
                .collect(),
        })
    }
}

impl PublishedReading {
    pub fn profiles(&self, scope: Option<&str>) -> Vec<&BrowserProfile> {
        let mut profiles: Vec<_> = self
            .profiles
            .iter()
            .filter(|profile| {
                scope.is_none_or(|id| profile.id == id)
                    && (self.shelves(&profile.id).next().is_some()
                        || self
                            .user(&profile.id)
                            .and_then(|user| user["readerProgress"].as_object())
                            .is_some_and(|progress| {
                                progress
                                    .values()
                                    .any(|entry| entry.is_object() && entry["hidden"] != true)
                            }))
            })
            .collect();
        profiles.sort_by_cached_key(|profile| profile.name.to_lowercase());
        profiles
    }

    pub fn enabled(&self, owner: &str) -> bool {
        self.profiles.iter().any(|user| user.id == owner)
    }

    pub fn pinned(&self, owner: &str) -> Vec<(&str, &str)> {
        if !self.enabled(owner) {
            return Vec::new();
        }
        let mut shelves: Vec<_> = self
            .shelves(owner)
            .filter(|item| item["opds"]["pinned"] == true)
            .filter_map(|item| Some((item["id"].as_str()?, item["name"].as_str()?)))
            .collect();
        shelves.sort_by_cached_key(|(_, name)| name.to_lowercase());
        shelves
    }

    pub fn lists(&self, owner: &str, catalogue: &Catalogue) -> Result<Value> {
        let user = self.user(owner).ok_or("Профиль OPDS не найден")?;
        shelves::listing(
            &self.data,
            user,
            owner,
            &json!({"options":{"visibility":"opds"}}),
            catalogue,
        )
    }

    pub fn list(&self, owner: &str, id: &str, catalogue: &Catalogue) -> Result<Option<Value>> {
        let Some(user) = self.user(owner) else {
            return Ok(None);
        };
        self.shelves(owner)
            .find(|item| item["id"] == id)
            .map(|item| shelves::detail_for(&self.data, user, owner, item, catalogue))
            .transpose()
    }

    pub fn progress(
        &self,
        owner: &str,
        state: &str,
        catalogue: &Catalogue,
    ) -> Result<Option<Value>> {
        self.user(owner)
            .map(|user| {
                library::reading_library(
                    &self.data,
                    user,
                    &json!({"state":state,"limit":300}),
                    catalogue,
                )
            })
            .transpose()
    }

    fn user(&self, owner: &str) -> Option<&Value> {
        self.enabled(owner)
            .then(|| {
                self.data["users"]
                    .as_array()?
                    .iter()
                    .find(|row| row["id"] == owner)
            })
            .flatten()
    }

    fn shelves<'a>(&'a self, owner: &str) -> impl Iterator<Item = &'a Value> {
        self.data["lists"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(move |row| shelves::owned(row, owner) && row["visibility"] == "opds")
    }
}
