//! A source read as UTF-8 whatever its bytes are.
//!
//! The XML reader stops at the first byte that is not UTF-8. An export with
//! such a byte in one note is still worth importing, so the bytes that are
//! not text become U+FFFD before the XML reader sees them, the way
//! `String::from_utf8_lossy` does it for a whole value.
use std::io::{self, BufRead, Read};

const REPLACEMENT: &[u8] = "\u{fffd}".as_bytes();

pub(crate) struct Utf8Lossy<R> {
    source: R,
    /// Text that has been checked; `ready[at..]` is still to be read.
    ready: Vec<u8>,
    at: usize,
    /// The beginning of a character whose other bytes are in the next piece.
    held: Vec<u8>,
    ended: bool,
}

impl<R: BufRead> Utf8Lossy<R> {
    pub(crate) fn new(source: R) -> Self {
        Self {
            source,
            ready: Vec::new(),
            at: 0,
            held: Vec::new(),
            ended: false,
        }
    }

    /// Takes the next piece of the source and leaves its text in `ready`.
    fn take_piece(&mut self) -> io::Result<()> {
        self.ready.clear();
        self.at = 0;
        let piece = self.source.fill_buf()?;
        if piece.is_empty() {
            self.ended = true;
            if !self.held.is_empty() {
                // The source ends in the middle of a character.
                self.held.clear();
                self.ready.extend_from_slice(REPLACEMENT);
            }
            return Ok(());
        }
        let length = piece.len();
        let joined;
        let mut rest = if self.held.is_empty() {
            piece
        } else {
            joined = [&self.held[..], piece].concat();
            self.held.clear();
            &joined[..]
        };
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(_) => {
                    self.ready.extend_from_slice(rest);
                    break;
                }
                Err(error) => {
                    let (text, other) = rest.split_at(error.valid_up_to());
                    self.ready.extend_from_slice(text);
                    match error.error_len() {
                        Some(wrong) => {
                            self.ready.extend_from_slice(REPLACEMENT);
                            rest = &other[wrong..];
                        }
                        // A character that may be whole with the next piece.
                        None => {
                            self.held.extend_from_slice(other);
                            break;
                        }
                    }
                }
            }
        }
        self.source.consume(length);
        Ok(())
    }
}

impl<R: BufRead> BufRead for Utf8Lossy<R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        while self.at == self.ready.len() && !self.ended {
            self.take_piece()?;
        }
        Ok(&self.ready[self.at..])
    }

    fn consume(&mut self, amount: usize) {
        self.at = (self.at + amount).min(self.ready.len());
    }
}

impl<R: BufRead> Read for Utf8Lossy<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let ready = self.fill_buf()?;
        let length = ready.len().min(out.len());
        out[..length].copy_from_slice(&ready[..length]);
        self.consume(length);
        Ok(length)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufReader, Cursor};

    use super::*;

    fn read(bytes: &[u8], piece: usize) -> Vec<u8> {
        let mut text = Vec::new();
        Utf8Lossy::new(BufReader::with_capacity(piece, Cursor::new(bytes)))
            .read_to_end(&mut text)
            .unwrap();
        text
    }

    #[test]
    fn text_is_read_as_it_is_however_it_is_cut_into_pieces() {
        let text = "plain, żółć, 日本語, 🦫 and the end";
        for piece in 1..12 {
            assert_eq!(
                read(text.as_bytes(), piece),
                text.as_bytes(),
                "pieces of {piece}"
            );
        }
        assert_eq!(read(b"", 4), b"");
    }

    #[test]
    fn bytes_that_are_not_text_become_what_from_utf8_lossy_makes_of_them() {
        let sources: [&[u8]; 7] = [
            b"a\xffb",
            b"\xff\xfe",
            // A character cut short by another, and by the end.
            b"caf\xc3 au lait",
            b"caf\xc3",
            b"\xe6\x97",
            // Too long a form of '/', a surrogate, and beyond the last character.
            b"x\xc0\xafy\xed\xa0\x80z\xf4\x90\x80\x80",
            "good \u{65e5}\u{672c} then \u{1f9ab}".as_bytes(),
        ];
        for source in sources {
            let expected = String::from_utf8_lossy(source).into_owned().into_bytes();
            for piece in 1..9 {
                assert_eq!(
                    read(source, piece),
                    expected,
                    "{source:?} in pieces of {piece}"
                );
            }
        }
    }
}
