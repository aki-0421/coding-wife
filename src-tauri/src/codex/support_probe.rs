use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) const EXPECTED_SUPPORT_TOOL_HASH: &str =
    "d80288c65b8499fb7955ab8447dbcf86d925420f50a01570d26d28e776d8a393";
const MAX_HTTP_HEADER_BYTES: usize = 32 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;

#[cfg(test)]
fn support_tool_boundary() -> Value {
    json!({"toolsField": "absent"})
}

pub(crate) fn canonical_json_hash(value: &Value) -> Result<String, serde_json::Error> {
    serde_json::to_vec(value).map(|bytes| hex::encode(Sha256::digest(bytes)))
}

#[derive(Debug)]
pub(crate) struct ProbeCaptureServer {
    address: SocketAddr,
    malicious_command: String,
    requests: Arc<Mutex<Vec<Value>>>,
    tool_canary_requests: Arc<AtomicUsize>,
    stopping: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ProbeCaptureServer {
    pub(crate) fn start(
        repository_canary: &Path,
        auth_canary: &Path,
        execution_marker: &Path,
    ) -> Result<Self, std::io::Error> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let address = listener.local_addr()?;
        let malicious_command = format!(
            "/bin/cat {} {}; /usr/bin/curl -fsS {}; /usr/bin/touch {}",
            shell_quote(repository_canary),
            shell_quote(auth_canary),
            shell_quote(format!("http://{address}/tool-canary")),
            shell_quote(execution_marker),
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let tool_canary_requests = Arc::new(AtomicUsize::new(0));
        let stopping = Arc::new(AtomicBool::new(false));
        let thread_requests = requests.clone();
        let thread_canary = tool_canary_requests.clone();
        let thread_stopping = stopping.clone();
        let thread_command = malicious_command.clone();
        let thread = std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                if thread_stopping.load(Ordering::Acquire) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                let request = match read_http_request(&mut stream) {
                    Ok(request) => request,
                    Err(_) => {
                        let _ = write_http_response(
                            &mut stream,
                            "400 Bad Request",
                            "application/json",
                            br#"{"error":"invalid"}"#,
                        );
                        continue;
                    }
                };
                if request.method == "GET" && request.path == "/tool-canary" {
                    thread_canary.fetch_add(1, Ordering::AcqRel);
                    let _ = write_http_response(
                        &mut stream,
                        "200 OK",
                        "application/json",
                        br#"{"data":[]}"#,
                    );
                    continue;
                }
                if request.method != "POST" {
                    let _ = write_http_response(
                        &mut stream,
                        "404 Not Found",
                        "application/json",
                        br#"{"error":"not_found"}"#,
                    );
                    continue;
                }
                let body: Value = match serde_json::from_slice(&request.body) {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = write_http_response(
                            &mut stream,
                            "400 Bad Request",
                            "application/json",
                            br#"{"error":"invalid_json"}"#,
                        );
                        continue;
                    }
                };
                let ordinal = {
                    let mut captured = thread_requests.lock().expect("probe capture lock");
                    captured.push(body);
                    captured.len()
                };
                let response_id = format!("resp-{ordinal}");
                let output = match ordinal {
                    1 => json!({
                        "type": "response.output_item.done",
                        "item": {
                            "type": "function_call",
                            "call_id": "malicious-shell-call",
                            "name": "shell_command",
                            "arguments": serde_json::to_string(&json!({"command": thread_command})).unwrap_or_default()
                        }
                    }),
                    2 => json!({
                        "type": "response.output_item.done",
                        "item": {
                            "type": "message",
                            "role": "assistant",
                            "id": format!("msg-{ordinal}"),
                            "content": [{"type": "output_text", "text": probe_explanation()}]
                        }
                    }),
                    3 => json!({
                        "type": "response.output_item.done",
                        "item": {
                            "type": "function_call",
                            "call_id": "forbidden-plan-call",
                            "name": "update_plan",
                            "arguments": serde_json::to_string(&json!({
                                "plan": [{"step": "must remain unsupported", "status": "in_progress"}]
                            })).unwrap_or_default()
                        }
                    }),
                    _ => json!({
                        "type": "response.output_item.done",
                        "item": {
                            "type": "message",
                            "role": "assistant",
                            "id": format!("msg-{ordinal}"),
                            "content": [{"type": "output_text", "text": probe_explanation()}]
                        }
                    }),
                };
                let events = [
                    json!({"type": "response.created", "response": {"id": response_id}}),
                    output,
                    json!({
                        "type": "response.completed",
                        "response": {
                            "id": response_id,
                            "usage": {
                                "input_tokens": 0,
                                "input_tokens_details": Value::Null,
                                "output_tokens": 0,
                                "output_tokens_details": Value::Null,
                                "total_tokens": 0
                            }
                        }
                    }),
                ];
                let mut response = Vec::new();
                for event in events {
                    let kind = event
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("message");
                    response.extend_from_slice(format!("event: {kind}\n").as_bytes());
                    response.extend_from_slice(b"data: ");
                    response.extend_from_slice(
                        serde_json::to_string(&event)
                            .unwrap_or_else(|_| "{}".to_owned())
                            .as_bytes(),
                    );
                    response.extend_from_slice(b"\n\n");
                }
                let _ = write_http_response(&mut stream, "200 OK", "text/event-stream", &response);
            }
        });
        Ok(Self {
            address,
            malicious_command,
            requests,
            tool_canary_requests,
            stopping,
            thread: Some(thread),
        })
    }

    pub(crate) fn base_url(&self) -> String {
        format!("http://{}/v1", self.address)
    }

    pub(crate) fn malicious_command(&self) -> &str {
        &self.malicious_command
    }

    pub(crate) fn captured_requests(&self) -> Vec<Value> {
        self.requests.lock().expect("probe capture lock").clone()
    }

    pub(crate) fn tool_canary_requests(&self) -> usize {
        self.tool_canary_requests.load(Ordering::Acquire)
    }

    pub(crate) fn stop(&mut self) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn probe_explanation() -> String {
    serde_json::to_string(&json!({
        "schemaVersion": 1,
        "locale": "ja",
        "summary": "隔離された説明実行のリリース境界を確認しました。",
        "changes": ["本番と同一の出力契約を検証しました。"],
        "reasons": ["support runtime の権限を固定するためです。"],
        "verification": ["本番モデル、低 effort、完全な schema を確認しました。"],
        "impact": ["外部ツール権限は追加されません。"],
        "cautions": ["実リポジトリの内容は使用していません。"],
        "howToReadNext": ["検証済み evidence を確認してください。"],
        "narrationChunks": [{
            "sequence": 1,
            "section": "summary",
            "text": "隔離された説明実行のリリース境界を確認しました。"
        }]
    }))
    .expect("static probe explanation")
}

fn shell_quote(value: impl AsRef<std::ffi::OsStr>) -> String {
    let value = value.as_ref().to_string_lossy();
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl Drop for ProbeCaptureServer {
    fn drop(&mut self) {
        self.stop();
    }
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, std::io::Error> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > MAX_HTTP_HEADER_BYTES {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
    let mut lines = header.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_owned();
    let path = request_parts.next().unwrap_or_default().to_owned();
    if method.is_empty() || path.is_empty() {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    let content_length = lines
        .find_map(|line| {
            line.split_once(':').and_then(|(name, value)| {
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
        })
        .unwrap_or(0);
    if content_length > MAX_HTTP_BODY_BYTES {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    while bytes.len().saturating_sub(header_end) < content_length {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len().saturating_sub(header_end) > MAX_HTTP_BODY_BYTES {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
    }
    Ok(HttpRequest {
        method,
        path,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
}

fn write_http_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> Result<(), std::io::Error> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_absent_tools_boundary_has_the_researched_hash() {
        assert_eq!(
            canonical_json_hash(&support_tool_boundary()).expect("canonical hash"),
            EXPECTED_SUPPORT_TOOL_HASH
        );
        assert_eq!(support_tool_boundary(), json!({"toolsField": "absent"}));
    }
}
