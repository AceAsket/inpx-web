use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

pub(crate) struct EpubInput {
    file: BufReader<File>,
    position: u64,
    size: u64,
}

impl EpubInput {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            file: BufReader::with_capacity(256 * 1024, file),
            position: 0,
            size,
        })
    }
}

impl Read for EpubInput {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let read = self.file.read(bytes)?;
        self.position += read as u64;
        Ok(read)
    }
}

impl BufRead for EpubInput {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        self.file.fill_buf()
    }

    fn consume(&mut self, amount: usize) {
        self.position += amount.min(self.file.buffer().len()) as u64;
        self.file.consume(amount);
    }
}

impl Seek for EpubInput {
    fn seek(&mut self, target: SeekFrom) -> io::Result<u64> {
        let position = match target {
            SeekFrom::Start(position) => Some(position),
            SeekFrom::Current(step) => self.position.checked_add_signed(step),
            SeekFrom::End(step) => self.size.checked_add_signed(step),
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Некорректное смещение EPUB"))?;
        // Buffered seeks avoid a kernel call for nearby ZIP headers.
        if let Ok(delta) = i64::try_from(i128::from(position) - i128::from(self.position)) {
            self.file.seek_relative(delta)?;
        } else {
            self.file.seek(SeekFrom::Start(position))?;
        }
        self.position = position;
        Ok(position)
    }

    fn stream_position(&mut self) -> io::Result<u64> {
        Ok(self.position)
    }
}
