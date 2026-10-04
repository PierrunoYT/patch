use std::collections::HashMap;

// Quotes one argument the way the Microsoft C runtime (and CommandLineToArgvW) parses it back.
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat('\\').take(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat('\\').take(backslashes * 2));
    out.push('"');
    out
}

// The program is always quoted, so a path with spaces is never split.
pub fn command_line(command: &str, args: &[String]) -> String {
    let mut line = format!("\"{command}\"");
    for arg in args {
        line.push(' ');
        line.push_str(&quote_arg(arg));
    }
    line
}

// UTF-16 environment block: sorted case-insensitively, each entry and the block end-terminated by NUL.
pub fn environment_block(env: &HashMap<String, String>) -> Vec<u16> {
    let mut entries: Vec<(&String, &String)> = env
        .iter()
        .filter(|(k, _)| !k.is_empty() && !k.contains('='))
        .collect();
    entries.sort_by_key(|(k, _)| k.to_uppercase());
    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

// Turns a byte stream into text without splitting a multi-byte character across two chunks.
#[derive(Default)]
pub struct Utf8Chunker {
    pending: Vec<u8>,
}

impl Utf8Chunker {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    match e.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + len);
                        }
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }

    pub fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        rest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_arguments_stay_unquoted() {
        assert_eq!(quote_arg("abc"), "abc");
        assert_eq!(quote_arg("-NoLogo"), "-NoLogo");
    }

    #[test]
    fn empty_and_spaced_arguments_are_quoted() {
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
    }

    #[test]
    fn quotes_are_escaped() {
        assert_eq!(quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn backslashes_double_only_before_a_quote_or_the_end() {
        assert_eq!(quote_arg(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(quote_arg(r"a\\b c"), r#""a\\b c""#);
        assert_eq!(quote_arg("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn command_line_quotes_the_program() {
        let line = command_line(
            r"C:\Program Files\x.exe",
            &["-c".into(), "Write-Output 'a b'".into()],
        );
        assert_eq!(line, r#""C:\Program Files\x.exe" -c "Write-Output 'a b'""#);
    }

    #[test]
    fn environment_block_is_sorted_and_double_terminated() {
        let mut env = HashMap::new();
        env.insert("b".to_string(), "2".to_string());
        env.insert("A".to_string(), "1".to_string());
        env.insert("bad=name".to_string(), "x".to_string());
        let text = String::from_utf16(&environment_block(&env)).unwrap();
        assert_eq!(text, "A=1\0b=2\0\0");
    }

    #[test]
    fn empty_environment_is_still_a_valid_block() {
        assert_eq!(environment_block(&HashMap::new()), vec![0, 0]);
    }

    #[test]
    fn chunker_keeps_split_characters_together() {
        let bytes = "é€".as_bytes();
        let mut chunker = Utf8Chunker::default();
        let mut out = chunker.push(&bytes[..1]);
        out += &chunker.push(&bytes[1..3]);
        out += &chunker.push(&bytes[3..]);
        assert_eq!(out, "é€");
        assert_eq!(chunker.finish(), "");
    }

    #[test]
    fn chunker_replaces_invalid_bytes() {
        let mut chunker = Utf8Chunker::default();
        assert_eq!(chunker.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        chunker.push(&[0xE2]);
        assert_eq!(chunker.finish(), "\u{FFFD}");
    }
}
