const PARAMS_LIMIT: usize = 32;
const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Ground,
    Escape,
    Csi,
    Text,
    TextEscape,
}

#[derive(Debug, Default)]
pub struct Scanner {
    state: State,
    params: Vec<u8>,
    bracketed: bool,
}

impl Scanner {
    pub fn bracketed(&self) -> bool {
        self.bracketed
    }

    pub fn at_ground(&self) -> bool {
        self.state == State::Ground
    }

    pub fn feed(&mut self, byte: u8) {
        self.state = match self.state {
            State::Ground => {
                if byte == ESC {
                    State::Escape
                } else {
                    State::Ground
                }
            }
            State::Escape => self.escape(byte),
            State::Csi => self.csi(byte),
            State::Text => match byte {
                BEL | CAN | SUB => State::Ground,
                ESC => State::TextEscape,
                _ => State::Text,
            },
            State::TextEscape => {
                if byte == b'\\' {
                    State::Ground
                } else {
                    self.escape(byte)
                }
            }
        };
    }

    fn escape(&mut self, byte: u8) -> State {
        match byte {
            b'[' => {
                self.params.clear();
                State::Csi
            }
            b']' | b'P' | b'_' | b'^' | b'X' => State::Text,
            ESC => State::Escape,
            0x20..=0x2f => State::Escape,
            _ => State::Ground,
        }
    }

    fn csi(&mut self, byte: u8) -> State {
        match byte {
            ESC => State::Escape,
            CAN | SUB => State::Ground,
            0x40..=0x7e => {
                self.finish_csi(byte);
                State::Ground
            }
            0x20..=0x3f => {
                if self.params.len() < PARAMS_LIMIT {
                    self.params.push(byte);
                }
                State::Csi
            }
            _ => State::Csi,
        }
    }

    fn finish_csi(&mut self, last: u8) {
        if last != b'h' && last != b'l' {
            return;
        }
        let Some(modes) = self.params.strip_prefix(b"?") else {
            return;
        };
        if modes.split(|byte| *byte == b';').any(|mode| mode == b"2004") {
            self.bracketed = last == b'h';
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scanned(bytes: &[u8]) -> Scanner {
        let mut scanner = Scanner::default();
        for byte in bytes {
            scanner.feed(*byte);
        }
        scanner
    }

    #[test]
    fn bracketed_paste_follows_the_last_mode_change() {
        assert!(!scanned(b"hola").bracketed());
        assert!(scanned(b"\x1b[?2004h").bracketed());
        assert!(!scanned(b"\x1b[?2004h\x1b[?2004l").bracketed());
        assert!(scanned(b"\x1b[?1049;2004h").bracketed());
        assert!(!scanned(b"\x1b[2004h").bracketed());
    }

    #[test]
    fn the_mode_survives_split_chunks() {
        let mut scanner = Scanner::default();
        for part in [&b"\x1b[?20"[..], &b"04"[..], &b"h"[..]] {
            for byte in part {
                scanner.feed(*byte);
            }
        }
        assert!(scanner.bracketed());
    }

    #[test]
    fn ground_is_left_inside_sequences_and_strings() {
        assert!(!scanned(b"\x1b[3").at_ground());
        assert!(!scanned(b"\x1b]0;title").at_ground());
        assert!(!scanned(b"\x1bP1;2q\n").at_ground());
        assert!(scanned(b"\x1b]0;title\x1b\\").at_ground());
        assert!(scanned(b"\x1b]0;title\x07").at_ground());
        assert!(scanned(b"\x1b[31mred\x1b[0m\n").at_ground());
        assert!(scanned(b"\x1b(B").at_ground());
    }
}
