use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::jsonl::JsonlFramer;
use super::protocol::{classify_message, client_request, InboundMessage, RpcId};

const OUTBOUND_QUEUE: usize = 128;
const MAX_PENDING_REQUESTS: usize = 128;
const RESOLVED_ID_WINDOW: usize = 256;
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug)]
pub enum RuntimeSignal {
    Inbound {
        generation: u64,
        message: InboundMessage,
    },
    ProtocolViolation {
        generation: u64,
        category: &'static str,
    },
    Disconnected {
        generation: u64,
        category: &'static str,
    },
}

#[derive(Clone, Debug, Error)]
pub enum RpcRequestError {
    #[error("the app-server request queue was full")]
    Overloaded,
    #[error("the app-server request timed out")]
    Timeout,
    #[error("the app-server connection was lost")]
    ConnectionLost,
    #[error("the app-server rejected the request")]
    Server { code: i64, category: &'static str },
    #[error("the app-server protocol was inconsistent")]
    Protocol,
}

struct PendingRequest {
    method: String,
    response: oneshot::Sender<Result<Value, RpcRequestError>>,
}

enum Outbound {
    Message(Value),
    Close,
}

#[derive(Clone)]
pub struct RpcConnection {
    generation: u64,
    next_id: Arc<AtomicU64>,
    writer: mpsc::Sender<Outbound>,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    resolved: Arc<Mutex<VecDeque<u64>>>,
    signals: mpsc::Sender<RuntimeSignal>,
}

impl RpcConnection {
    pub fn start(
        generation: u64,
        stdin: ChildStdin,
        stdout: ChildStdout,
        signals: mpsc::Sender<RuntimeSignal>,
    ) -> Self {
        let (writer, writer_rx) = mpsc::channel(OUTBOUND_QUEUE);
        let connection = Self {
            generation,
            next_id: Arc::new(AtomicU64::new(1)),
            writer,
            pending: Arc::new(Mutex::new(HashMap::new())),
            resolved: Arc::new(Mutex::new(VecDeque::new())),
            signals,
        };

        tokio::spawn(writer_task(
            generation,
            stdin,
            writer_rx,
            connection.signals.clone(),
        ));
        tokio::spawn(reader_task(
            generation,
            stdout,
            connection.pending.clone(),
            connection.resolved.clone(),
            connection.signals.clone(),
        ));
        connection
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcRequestError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(RpcRequestError::Overloaded);
            }
            pending.insert(
                id,
                PendingRequest {
                    method: method.to_owned(),
                    response: response_tx,
                },
            );
        }

        if self
            .writer
            .try_send(Outbound::Message(client_request(id, method, params)))
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err(RpcRequestError::Overloaded);
        }

        match tokio::time::timeout(timeout, response_rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Err(RpcRequestError::ConnectionLost),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(RpcRequestError::Timeout)
            }
        }
    }

    pub async fn request_default(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcRequestError> {
        self.request(method, params, DEFAULT_REQUEST_TIMEOUT).await
    }

    pub fn send(&self, message: Value) -> Result<(), RpcRequestError> {
        self.writer
            .try_send(Outbound::Message(message))
            .map_err(|_| RpcRequestError::Overloaded)
    }

    pub fn close(&self) {
        let _ = self.writer.try_send(Outbound::Close);
    }

    pub async fn fail_pending(&self) {
        fail_all_pending(&self.pending).await;
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

async fn writer_task(
    generation: u64,
    mut stdin: ChildStdin,
    mut receiver: mpsc::Receiver<Outbound>,
    signals: mpsc::Sender<RuntimeSignal>,
) {
    while let Some(outbound) = receiver.recv().await {
        let result = match outbound {
            Outbound::Message(message) => {
                let mut encoded = match serde_json::to_vec(&message) {
                    Ok(encoded) => encoded,
                    Err(_) => {
                        let _ = signals
                            .send(RuntimeSignal::ProtocolViolation {
                                generation,
                                category: "outbound_serialization",
                            })
                            .await;
                        break;
                    }
                };
                encoded.push(b'\n');
                stdin.write_all(&encoded).await
            }
            Outbound::Close => {
                let _ = stdin.shutdown().await;
                break;
            }
        };
        if result.is_err() {
            let _ = signals
                .send(RuntimeSignal::Disconnected {
                    generation,
                    category: "stdin_write",
                })
                .await;
            break;
        }
    }
}

async fn reader_task(
    generation: u64,
    mut stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    resolved: Arc<Mutex<VecDeque<u64>>>,
    signals: mpsc::Sender<RuntimeSignal>,
) {
    let mut framer = JsonlFramer::default();
    let mut buffer = vec![0_u8; 16 * 1024];
    loop {
        let count = match stdout.read(&mut buffer).await {
            Ok(0) => {
                if framer.finish().is_err() {
                    let _ = signals
                        .send(RuntimeSignal::ProtocolViolation {
                            generation,
                            category: "truncated_jsonl",
                        })
                        .await;
                }
                fail_all_pending(&pending).await;
                let _ = signals
                    .send(RuntimeSignal::Disconnected {
                        generation,
                        category: "stdout_eof",
                    })
                    .await;
                break;
            }
            Ok(count) => count,
            Err(_) => {
                fail_all_pending(&pending).await;
                let _ = signals
                    .send(RuntimeSignal::Disconnected {
                        generation,
                        category: "stdout_read",
                    })
                    .await;
                break;
            }
        };

        let frames = match framer.push(&buffer[..count]) {
            Ok(frames) => frames,
            Err(_) => {
                fail_all_pending(&pending).await;
                let _ = signals
                    .send(RuntimeSignal::ProtocolViolation {
                        generation,
                        category: "invalid_jsonl",
                    })
                    .await;
                break;
            }
        };

        for frame in frames {
            let byte_count = serde_json::to_vec(&frame).map_or(0, |encoded| encoded.len());
            match classify_message(frame, byte_count) {
                Ok(InboundMessage::Response { id, result }) => {
                    let RpcId::Unsigned(id) = id else {
                        let _ = signals
                            .send(RuntimeSignal::ProtocolViolation {
                                generation,
                                category: "response_id_type",
                            })
                            .await;
                        return;
                    };
                    let request = pending.lock().await.remove(&id);
                    if let Some(request) = request {
                        let mapped = result.map_err(|error| RpcRequestError::Server {
                            code: error.code,
                            category: error.category,
                        });
                        let _method = request.method;
                        let _ = request.response.send(mapped);
                        let mut resolved = resolved.lock().await;
                        resolved.push_back(id);
                        while resolved.len() > RESOLVED_ID_WINDOW {
                            resolved.pop_front();
                        }
                    } else {
                        let category = if resolved.lock().await.contains(&id) {
                            "duplicate_response"
                        } else {
                            "unknown_response"
                        };
                        let _ = signals
                            .send(RuntimeSignal::ProtocolViolation {
                                generation,
                                category,
                            })
                            .await;
                        return;
                    }
                }
                Ok(message) => {
                    if signals
                        .send(RuntimeSignal::Inbound {
                            generation,
                            message,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Err(_) => {
                    let _ = signals
                        .send(RuntimeSignal::ProtocolViolation {
                            generation,
                            category: "invalid_rpc",
                        })
                        .await;
                    return;
                }
            }
        }
    }
}

async fn fail_all_pending(pending: &Arc<Mutex<HashMap<u64, PendingRequest>>>) {
    let requests = std::mem::take(&mut *pending.lock().await);
    for (_, request) in requests {
        let _ = request.response.send(Err(RpcRequestError::ConnectionLost));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn failing_pending_requests_never_synthesizes_success() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(
            1,
            PendingRequest {
                method: "turn/start".to_owned(),
                response: sender,
            },
        );

        fail_all_pending(&pending).await;

        assert!(matches!(
            receiver.await,
            Ok(Err(RpcRequestError::ConnectionLost))
        ));
        assert!(pending.lock().await.is_empty());
    }
}
