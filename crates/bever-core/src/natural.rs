//! The order names are listed in: as a person reads them.
//!
//! Letters compare without regard to case, and a run of digits compares as
//! the number it writes, so `note-2` comes before `note-10`, `001-note`
//! before `2-note`, and `b9` before `b010`. Notebooks, stacks, tags, and
//! notes sorted by title all use it, through the `NATSORT` collation that
//! [`crate::db::Library`] gives every connection.
use std::{cmp::Ordering, iter::Peekable, str::Chars};

/// The name of the collation in SQL: `ORDER BY name COLLATE NATSORT`.
pub const COLLATION: &str = "NATSORT";

/// Takes a run of digits: its value's digits without leading zeros, and how
/// many zeros led it.
fn number(characters: &mut Peekable<Chars<'_>>) -> (String, usize) {
    let mut zeros = 0;
    let mut digits = String::new();
    while let Some(digit) = characters.peek().copied().filter(char::is_ascii_digit) {
        characters.next();
        if digit == '0' && digits.is_empty() {
            zeros += 1;
        } else {
            digits.push(digit);
        }
    }
    (digits, zeros)
}

pub fn compare(left: &str, right: &str) -> Ordering {
    let (mut a, mut b) = (left.chars().peekable(), right.chars().peekable());
    // Decides between names that read the same: "note 1" and "note 01".
    let mut zeros = Ordering::Equal;
    loop {
        let (Some(x), Some(y)) = (a.peek().copied(), b.peek().copied()) else {
            // The shorter name first; names of one length read the same.
            return a
                .peek()
                .is_some()
                .cmp(&b.peek().is_some())
                .then(zeros)
                .then_with(|| left.cmp(right));
        };
        if x.is_ascii_digit() && y.is_ascii_digit() {
            let ((value_a, zeros_a), (value_b, zeros_b)) = (number(&mut a), number(&mut b));
            // Without leading zeros, the longer number is the greater.
            let order = value_a
                .len()
                .cmp(&value_b.len())
                .then_with(|| value_a.cmp(&value_b));
            if order != Ordering::Equal {
                return order;
            }
            zeros = zeros.then(zeros_a.cmp(&zeros_b));
        } else {
            let order = x.to_lowercase().cmp(y.to_lowercase());
            if order != Ordering::Equal {
                return order;
            }
            a.next();
            b.next();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut names: Vec<&str>) -> Vec<&str> {
        names.sort_by(|a, b| compare(a, b));
        names
    }

    #[test]
    fn numbers_in_names_are_read_as_numbers() {
        assert_eq!(
            sorted(vec![
                "my-note-10",
                "my-note-002",
                "my-note-1",
                "my-note-001"
            ]),
            ["my-note-1", "my-note-001", "my-note-002", "my-note-10"]
        );
        assert_eq!(
            sorted(vec!["10-note", "2-note", "001-note", "1-note"]),
            ["1-note", "001-note", "2-note", "10-note"]
        );
        assert_eq!(
            sorted(vec!["b010-note", "b9-note", "b001-note", "a100"]),
            ["a100", "b001-note", "b9-note", "b010-note"]
        );
        // Several numbers in one name, each in its turn.
        assert_eq!(
            sorted(vec![
                "a | 2 | 10 x",
                "a | 10 | 1 x",
                "a | 2 | 9 x",
                "a | 2 x"
            ]),
            ["a | 2 x", "a | 2 | 9 x", "a | 2 | 10 x", "a | 10 | 1 x"]
        );
        // Numbers longer than any integer type are still numbers.
        assert_eq!(
            compare("id 99999999999999999999998", "id 99999999999999999999999"),
            Ordering::Less
        );
    }

    #[test]
    fn letters_are_compared_without_regard_to_case() {
        assert_eq!(
            sorted(vec!["banana", "Apple", "cherry", "apple pie", "Ärger"]),
            ["Apple", "apple pie", "banana", "cherry", "Ärger"]
        );
        assert_eq!(compare("Note", "note 1"), Ordering::Less);
        assert_eq!(compare("", "a"), Ordering::Less);
    }

    #[test]
    fn the_order_is_total() {
        // Names that read the same still have one order, whichever way
        // they are compared.
        for (a, b) in [("Note", "note"), ("note 1", "note 01"), ("a", "a")] {
            assert_eq!(compare(a, b), compare(b, a).reverse(), "{a} / {b}");
        }
        assert_eq!(compare("note 1", "note 01"), Ordering::Less);
        assert_ne!(compare("Note", "note"), Ordering::Equal);
        assert_eq!(compare("same", "same"), Ordering::Equal);
    }
}
