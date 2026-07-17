use serde_json::Value;
use thiserror::Error;

pub const MAX_JSONL_LINE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_JSONL_BUFFER_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum JsonlError {
    #[error("the JSONL line exceeded the configured bound")]
    LineTooLarge,
    #[error("the unfinished JSONL buffer exceeded the configured bound")]
    BufferTooLarge,
    #[error("the JSONL line was not valid UTF-8 JSON")]
    Malformed,
    #[error("the JSONL frame was not an object")]
    NotObject,
    #[error("the JSONL stream ended with an unfinished frame")]
    Truncated,
}

#[derive(Debug)]
pub struct JsonlFramer {
    buffer: Vec<u8>,
    max_line_bytes: usize,
    max_buffer_bytes: usize,
}

impl Default for JsonlFramer {
    fn default() -> Self {
        Self::with_limits(MAX_JSONL_LINE_BYTES, MAX_JSONL_BUFFER_BYTES)
    }
}

impl JsonlFramer {
    pub fn with_limits(max_line_bytes: usize, max_buffer_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_line_bytes,
            max_buffer_bytes,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, JsonlError> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > self.max_buffer_bytes {
            self.buffer.clear();
            return Err(JsonlError::BufferTooLarge);
        }

        let mut frames = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            if line.len() > self.max_line_bytes {
                self.buffer.clear();
                return Err(JsonlError::LineTooLarge);
            }

            let value: Value = serde_json::from_slice(&line).map_err(|_| JsonlError::Malformed)?;
            if !value.is_object() {
                return Err(JsonlError::NotObject);
            }
            frames.push(value);
        }

        if self.buffer.len() > self.max_line_bytes {
            self.buffer.clear();
            return Err(JsonlError::LineTooLarge);
        }

        Ok(frames)
    }

    pub fn finish(mut self) -> Result<(), JsonlError> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            self.buffer.clear();
            Ok(())
        } else {
            Err(JsonlError::Truncated)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_fragmented_utf8_and_multiple_lines() {
        let mut framer = JsonlFramer::with_limits(128, 256);
        let bytes = "{\"message\":\"日本語\"}\n{\"id\":2}\r\n".as_bytes();
        let split = 17;

        assert!(framer
            .push(&bytes[..split])
            .expect("first fragment")
            .is_empty());
        let frames = framer.push(&bytes[split..]).expect("second fragment");

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["message"], "日本語");
        assert_eq!(frames[1]["id"], 2);
        assert_eq!(framer.finish(), Ok(()));
    }

    #[test]
    fn rejects_malformed_non_object_and_truncated_frames() {
        let mut malformed = JsonlFramer::with_limits(32, 64);
        assert_eq!(malformed.push(b"{bad}\n"), Err(JsonlError::Malformed));

        let mut array = JsonlFramer::with_limits(32, 64);
        assert_eq!(array.push(b"[]\n"), Err(JsonlError::NotObject));

        let mut truncated = JsonlFramer::with_limits(32, 64);
        assert!(truncated.push(b"{\"id\":1").expect("buffered").is_empty());
        assert_eq!(truncated.finish(), Err(JsonlError::Truncated));
    }

    #[test]
    fn enforces_line_and_buffer_limits() {
        let mut line = JsonlFramer::with_limits(8, 32);
        assert_eq!(line.push(b"{\"long\":1}\n"), Err(JsonlError::LineTooLarge));

        let mut buffer = JsonlFramer::with_limits(64, 8);
        assert_eq!(buffer.push(b"123456789"), Err(JsonlError::BufferTooLarge));
    }
}
