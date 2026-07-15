//! AWS Signature Version 4 signing.
//!
//! Implemented by hand (not the AWS SDK) so signing behaves identically
//! across S3-compatible providers (MinIO, R2, B2, Wasabi, RustFS).
//! Pure functions only: callers supply the timestamp — no clocks, no I/O —
//! which keeps the module deterministic and WASM-clean.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Payload-hash sentinel for requests whose body is not hashed (streaming).
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

/// Hex SHA-256 of an empty payload.
pub const EMPTY_PAYLOAD_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
}

/// AWS UriEncode: unreserved characters (A-Za-z0-9, `-`, `.`, `_`, `~`) pass
/// through; everything else becomes uppercase percent-escapes per UTF-8 byte.
/// `/` is kept literal when `encode_slash` is false (URI paths).
pub fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            b'/' if !encode_slash => out.push('/'),
            _ => {
                out.push('%');
                out.push_str(&format!("{byte:02X}"));
            }
        }
    }
    out
}

/// Encoded `k=v` pairs joined by `&`, sorted by encoded key then value.
pub fn canonical_query_string(query: &[(&str, &str)]) -> String {
    let mut pairs: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| (uri_encode(k, true), uri_encode(v, true)))
        .collect();
    pairs.sort();
    let encoded: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect();
    encoded.join("&")
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// SigV4 key derivation: HMAC chain over date, region, service, terminator.
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let key = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let key = hmac_sha256(&key, region.as_bytes());
    let key = hmac_sha256(&key, service.as_bytes());
    hmac_sha256(&key, b"aws4_request")
}

#[cfg(test)]
mod tests {
    use crate::signer::*;

    #[test]
    fn uri_encode_keeps_unreserved_characters() {
        assert_eq!(uri_encode("AZaz09-._~", true), "AZaz09-._~");
    }

    #[test]
    fn uri_encode_encodes_reserved_characters_uppercase_hex() {
        assert_eq!(uri_encode("a b+c$d", true), "a%20b%2Bc%24d");
        assert_eq!(uri_encode("key=value&x", true), "key%3Dvalue%26x");
    }

    #[test]
    fn uri_encode_slash_behavior_depends_on_flag() {
        assert_eq!(uri_encode("photos/2026/trip", false), "photos/2026/trip");
        assert_eq!(uri_encode("photos/2026/trip", true), "photos%2F2026%2Ftrip");
    }

    #[test]
    fn uri_encode_handles_utf8_bytes() {
        assert_eq!(uri_encode("ü", true), "%C3%BC");
    }

    #[test]
    fn canonical_query_string_sorts_by_encoded_key() {
        let q = [("prefix", "J"), ("max-keys", "2")];
        assert_eq!(canonical_query_string(&q), "max-keys=2&prefix=J");
    }

    #[test]
    fn canonical_query_string_encodes_keys_and_values() {
        let q = [("key with space", "value/slash")];
        assert_eq!(
            canonical_query_string(&q),
            "key%20with%20space=value%2Fslash"
        );
    }

    #[test]
    fn canonical_query_string_keeps_empty_values() {
        let q = [("lifecycle", "")];
        assert_eq!(canonical_query_string(&q), "lifecycle=");
    }

    #[test]
    fn sha256_hex_of_empty_input_is_known_constant() {
        assert_eq!(sha256_hex(b""), EMPTY_PAYLOAD_SHA256);
    }

    #[test]
    fn signing_key_derivation_chain() {
        // Derived key for the shared AWS example inputs; verified end-to-end
        // by the full signature vectors in Task 2 — here we assert the chain
        // is deterministic and 32 bytes (HMAC-SHA256 output).
        let key = signing_key(
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "20130524",
            "us-east-1",
            "s3",
        );
        assert_eq!(key.len(), 32);
        assert_eq!(
            key,
            signing_key(
                "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                "20130524",
                "us-east-1",
                "s3",
            )
        );
    }
}
