//! 增量拆帧器 —— 与 TS `FrameReader` 同构。
//!
//! TCP 是字节流：一帧可能分多个 chunk 到达，一个 chunk 也可能带多帧。三种抛错
//! （坏长度、坏 JSON、结构不合法）都表示「帧边界已不可信」，调用方必须销毁连接。
//!
//! 长度检查在**读到前缀的那一刻**执行，而不是等字节攒够：恶意前缀声称 100MiB 时，
//! 等待就是攻击本身（内存被 chunks 一路填满）。

use ofs_contract::{FrameError, SyncFrame, MAX_FRAME_BYTES};
use serde_json::Value;

use crate::validate;

pub struct FrameReader {
    chunks: Vec<Vec<u8>>,
    buffered: usize,
    /// 保持 `f64`：TS 的 `setMaxBytes(n)` 接受任意 number（含 NaN），
    /// 而 `bodyLen > NaN` 恒为 false —— 语义要对齐就不能私自取整。
    max_bytes: f64,
}

impl Default for FrameReader {
    fn default() -> Self {
        Self::new(MAX_FRAME_BYTES as f64)
    }
}

impl FrameReader {
    pub fn new(max_bytes: f64) -> Self {
        Self {
            chunks: Vec::new(),
            buffered: 0,
            max_bytes,
        }
    }

    pub fn set_max_bytes(&mut self, max_bytes: f64) {
        self.max_bytes = max_bytes;
    }

    pub fn buffered(&self) -> usize {
        self.buffered
    }

    /// 送入一段字节，返回本次凑齐的全部帧。任何不合法 → `Err`，调用方断连。
    pub fn feed(&mut self, chunk: Vec<u8>) -> Result<Vec<SyncFrame>, FrameError> {
        let mut frames: Vec<SyncFrame> = Vec::new();
        if chunk.is_empty() {
            return Ok(frames);
        }
        self.buffered += chunk.len();
        self.chunks.push(chunk);
        while self.buffered >= 4 {
            let body_len = self.peek_body_length();
            if body_len == 0 || f64::from(body_len) > self.max_bytes {
                return Err(FrameError::FrameLenInvalid(body_len));
            }
            let total = 4 + body_len as usize;
            if self.buffered < total {
                break;
            }
            let whole = self.take(total);
            // TS 用 `buf.toString('utf8')`：非法字节会被替换成 U+FFFD 而不是抛错，
            // 所以这里也必须 lossy 解码，否则「坏 UTF-8」会被归到错误的错误桶里。
            let text = String::from_utf8_lossy(&whole[4..]);
            let parsed: Value =
                serde_json::from_str(&text).map_err(|_| FrameError::FrameJsonInvalid)?;
            let frame = validate::parse_frame(&parsed).ok_or(FrameError::FrameShapeInvalid)?;
            frames.push(frame);
        }
        Ok(frames)
    }

    fn peek_body_length(&mut self) -> u32 {
        if self.chunks.first().map(|chunk| chunk.len()).unwrap_or(0) < 4 {
            let mut merged = Vec::with_capacity(self.buffered);
            for chunk in self.chunks.drain(..) {
                merged.extend_from_slice(&chunk);
            }
            self.chunks.push(merged);
        }
        let head = &self.chunks[0];
        u32::from_be_bytes([head[0], head[1], head[2], head[3]])
    }

    fn take(&mut self, count: usize) -> Vec<u8> {
        debug_assert!(count <= self.buffered);
        self.buffered -= count;
        if self.chunks.len() == 1 {
            let mut merged = self.chunks.pop().expect("single chunk");
            let rest = merged.split_off(count);
            if !rest.is_empty() {
                self.chunks.push(rest);
            }
            return merged;
        }
        let mut merged = Vec::with_capacity(count);
        for chunk in self.chunks.drain(..) {
            merged.extend_from_slice(&chunk);
        }
        let rest = merged.split_off(count);
        if !rest.is_empty() {
            self.chunks.push(rest);
        }
        merged
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ofs_contract::MAX_FRAME_BYTES;

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn splits_multiple_frames_in_one_chunk() {
        let mut reader = FrameReader::default();
        let mut bytes = framed(br#"{"kind":"received"}"#);
        bytes.extend(framed(br#"{"kind":"rejected"}"#));
        let frames = reader.feed(bytes).expect("ok");
        assert_eq!(frames, vec![SyncFrame::Received, SyncFrame::Rejected]);
    }

    #[test]
    fn accepts_a_frame_one_byte_at_a_time() {
        let mut reader = FrameReader::default();
        let bytes = framed(br#"{"kind":"received"}"#);
        let mut frames = Vec::new();
        for byte in bytes {
            frames.extend(reader.feed(vec![byte]).expect("ok"));
        }
        assert_eq!(frames, vec![SyncFrame::Received]);
    }

    #[test]
    fn rejects_bad_length_as_soon_as_the_prefix_arrives() {
        let mut reader = FrameReader::new(MAX_FRAME_BYTES as f64);
        let mut head = Vec::new();
        head.extend_from_slice(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes());
        assert_eq!(
            reader.feed(head),
            Err(FrameError::FrameLenInvalid((MAX_FRAME_BYTES as u32) + 1))
        );
    }

    #[test]
    fn rejects_zero_length() {
        let mut reader = FrameReader::default();
        assert_eq!(
            reader.feed(vec![0, 0, 0, 0]),
            Err(FrameError::FrameLenInvalid(0))
        );
    }

    #[test]
    fn rejects_non_json_and_bad_shape() {
        let mut reader = FrameReader::default();
        assert_eq!(
            reader.feed(framed(b"junk-not-json")),
            Err(FrameError::FrameJsonInvalid)
        );
        let mut shape = FrameReader::default();
        assert_eq!(
            shape.feed(framed(br#"{"kind":"hello","magic":"NOPE"}"#)),
            Err(FrameError::FrameShapeInvalid)
        );
    }

    #[test]
    fn waits_for_the_rest_of_the_body() {
        let mut reader = FrameReader::default();
        let bytes = framed(br#"{"kind":"received"}"#);
        assert_eq!(reader.feed(bytes[..6].to_vec()), Ok(vec![]));
        assert_eq!(
            reader.feed(bytes[6..].to_vec()),
            Ok(vec![SyncFrame::Received])
        );
    }
}
