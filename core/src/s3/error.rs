use thiserror::Error;

/// Error taxonomy per design spec §8.4: retryable transport/provider
/// failures, conflicts surfaced to the caller, and fatal errors.
#[derive(Debug, Error)]
pub enum S3Error {
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("object not found: {key}")]
    NotFound { key: String },
    #[error("precondition failed (etag mismatch)")]
    PreconditionFailed,
    #[error("access denied: {message}")]
    AccessDenied { message: String },
    #[error("provider error {status}: {message}")]
    Provider {
        status: u16,
        message: String,
        retryable: bool,
    },
    #[error("network error: {0}")]
    Network(String),
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    #[error("not supported by provider: {message}")]
    Unsupported { message: String },
}

impl S3Error {
    pub fn is_retryable(&self) -> bool {
        match self {
            S3Error::Network(_) => true,
            S3Error::Provider { retryable, .. } => *retryable,
            _ => false,
        }
    }
}
