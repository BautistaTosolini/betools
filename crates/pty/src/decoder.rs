//! Decodificador UTF-8 por flujo: no parte caracteres multibyte entre bloques (como el de node-pty).

#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    /// Devuelve el texto completo decodificable; la cola incompleta espera al próximo bloque.
    /// Los bytes inválidos se reemplazan por U+FFFD, igual que `TextDecoder`.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(bytes);
        let mut out = String::with_capacity(buf.len());
        let mut i = 0;
        while i < buf.len() {
            match std::str::from_utf8(&buf[i..]) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(&String::from_utf8_lossy(&buf[i..i + valid]));
                    i += valid;
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            i += n;
                        }
                        None => {
                            self.pending = buf[i..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// Al cerrarse el flujo, una secuencia cortada se emite como carácter de reemplazo.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            self.pending.clear();
            "\u{FFFD}".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_multibyte_across_chunks() {
        let bytes = "añ€😀".as_bytes();
        for cut in 1..bytes.len() {
            let mut d = Utf8Decoder::default();
            let mut s = d.push(&bytes[..cut]);
            s.push_str(&d.push(&bytes[cut..]));
            assert_eq!(s, "añ€😀", "cut {cut}");
        }
    }

    #[test]
    fn byte_by_byte() {
        let mut d = Utf8Decoder::default();
        let s: String = "héllo 😀".as_bytes().iter().map(|b| d.push(&[*b])).collect();
        assert_eq!(s, "héllo 😀");
    }

    #[test]
    fn invalid_bytes_become_replacement() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.push(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(d.push(&[0xe2, 0x82]), "");
        assert_eq!(d.finish(), "\u{FFFD}");
        assert_eq!(d.finish(), "");
    }
}
