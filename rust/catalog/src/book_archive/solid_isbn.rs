use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};

use super::*;

type Targets = Vec<(usize, Format)>;
type Numbers = Vec<(usize, Vec<String>)>;

// The decoder pauses inside its entry callback at the end of each catalogue
// page. Its dictionary and file position stay valid without reading ahead.
pub(super) struct Cursor {
    archive: Arc<SevenZip>,
    block: usize,
    last: usize,
    requests: Option<SyncSender<Targets>>,
    results: Receiver<Numbers>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for Cursor {
    fn drop(&mut self) {
        self.requests.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(super) fn read(
    cursor: &mut Option<Cursor>,
    archive: &Arc<SevenZip>,
    (block, members): &IsbnBlock<'_>,
    limit: u64,
    cancel: &Arc<AtomicBool>,
    open: impl FnOnce() -> Option<BufReader<File>>,
    found: &mut IsbnFound<'_>,
) -> bool {
    let starts = &archive.archive.stream_map.block_first_file_index;
    let end = starts
        .get(block + 1)
        .copied()
        .unwrap_or(archive.archive.files.len());
    let start = starts[*block];
    if end - start <= 1 {
        return false;
    }
    let mut targets: Targets = members
        .iter()
        .map(|(&index, rows)| (index, rows[0].format))
        .collect();
    targets.sort_unstable_by_key(|target| target.0);
    let first = targets[0].0;
    let last = targets.last().expect("nonempty ISBN block").0;
    if !cursor
        .as_ref()
        .is_some_and(|c| Arc::ptr_eq(&c.archive, archive) && c.block == *block && c.last < first)
    {
        *cursor = None;
        // A single pass already suffices when the final member is requested.
        if last + 1 == end {
            return false;
        }
        let Some(input) = open() else { return false };
        *cursor = Cursor::start(archive.clone(), *block, input, limit, cancel.clone());
    }
    let Some(active) = cursor else { return false };
    let requests = active.requests.as_ref().expect("open ISBN cursor");
    if requests.send(targets).is_err() {
        return false;
    }
    let Ok(numbers) = active.results.recv() else {
        return false;
    };
    for (index, numbers) in numbers {
        for member in &members[&index] {
            found(member.row, numbers.clone());
        }
    }
    active.last = last;
    if last + 1 == end {
        *cursor = None;
    }
    true
}

impl Cursor {
    fn start(
        archive: Arc<SevenZip>,
        block: usize,
        mut input: BufReader<File>,
        limit: u64,
        cancel: Arc<AtomicBool>,
    ) -> Option<Self> {
        let (requests, incoming) = mpsc::sync_channel::<Targets>(0);
        let (outgoing, results) = mpsc::channel();
        let directory = archive.clone();
        let worker = thread::Builder::new()
            .name("isbn-solid".into())
            .spawn(move || {
                let Ok(first) = incoming.recv() else { return };
                let mut targets = first.into_iter().peekable();
                let mut numbers = Vec::new();
                let mut index = directory.archive.stream_map.block_first_file_index[block];
                // Large decoders use the existing serialized path. Never hold its
                // process-wide memory permit while waiting for another page.
                let decoder = BlockDecoder::new_with_memory_limit(
                    1,
                    SEVEN_ZIP_MEMORY_KIB,
                    block,
                    &directory.archive,
                    &directory.password,
                    &mut input,
                );
                let _ = decoder.for_each_entries(&mut |entry, reader| {
                    if cancel.load(Ordering::Acquire) {
                        return Ok(false);
                    }
                    if let Some((_, format)) = targets.next_if(|(wanted, _)| *wanted == index) {
                        if let Ok(values) = format.isbn_numbers(entry.size, reader, limit) {
                            numbers.push((index, values));
                        }
                        if targets.peek().is_none() {
                            if outgoing.send(std::mem::take(&mut numbers)).is_err() {
                                return Ok(false);
                            }
                            let Ok(next) = incoming.recv() else {
                                return Ok(false);
                            };
                            if cancel.load(Ordering::Acquire) {
                                return Ok(false);
                            }
                            targets = next.into_iter().peekable();
                        }
                    }
                    index += 1;
                    Ok(true)
                });
            })
            .ok()?;
        Some(Self {
            archive,
            block,
            last: 0,
            requests: Some(requests),
            results,
            worker: Some(worker),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};

    #[test]
    fn solid_pages_reuse_the_decoder_and_rewind_for_earlier_entries() {
        // Four tiny FB2 files in one LZMA2 block. The third has no ISBN.
        let encoded = concat!(
            "N3q8ryccAAQJSMg0wwAAAAAAAAAhAAAAAAAAABwLPwTgAaYAY10AHhGJJjPZvDvmec9to3EqFkDfLoTPW156hzIm6036HCcwK6slm5qhVfPL+TyAD6CYydMsXUhLoAaUS7TZq/61MpDjHny8mzz8eCuyGCWXw/vT83mjQfkZjZvnUTLOPtfzixgAAAAA",
            "gTMHrg/UHdO9QMCQ0v99aU2POjdNZrDV6ppP+7eFGKVE8nREYwt2ij0dVcbKX/CoMgUUA2ZonslzH9PnDmkQDbFxbJZ0FiUEsJApFMWBQGedZdjtRoAXBmsBCVgABwsBAAEjAwEBBV0AEAAADICGCgHxBbflAAA="
        );
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&STANDARD.decode(encoded).unwrap()).unwrap();
        let archive = Arc::new(SevenZip::open(&mut file.reopen().unwrap()).unwrap());
        let cancel = Arc::new(AtomicBool::new(false));
        let mut cursor = None;
        let mut opens = 0;
        let mut page = |index, expected: &[&str]| {
            let member = IsbnMember {
                row: index,
                name: format!("{}.fb2", index + 1),
                format: Format::Fb2,
            };
            let block = (0, HashMap::from([(index, vec![&member])]));
            let mut result = None;
            assert!(read(
                &mut cursor,
                &archive,
                &block,
                65536,
                &cancel,
                || {
                    opens += 1;
                    Some(BufReader::new(file.reopen().unwrap()))
                },
                &mut |row, numbers| {
                    assert_eq!(row, index);
                    result = Some(numbers)
                }
            ));
            assert_eq!(result.unwrap(), expected);
        };
        page(0, &["9780306406157"]);
        page(2, &[]);
        page(1, &["9783161484100"]);
        page(3, &["9780131103627"]);
        assert_eq!(opens, 2);
        assert!(cursor.is_none());

        let worker = Cursor::start(
            archive,
            0,
            BufReader::new(file.reopen().unwrap()),
            65536,
            cancel.clone(),
        )
        .unwrap();
        let requests = worker.requests.as_ref().unwrap();
        requests.send(vec![(0, Format::Fb2)]).unwrap();
        assert_eq!(worker.results.recv().unwrap().len(), 1);
        cancel.store(true, Ordering::Release);
        requests.send(vec![(1, Format::Fb2)]).unwrap();
        assert!(worker.results.recv().is_err());
    }
}
