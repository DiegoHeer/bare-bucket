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

pub struct SigningContext<'a> {
    pub credentials: &'a Credentials,
    pub region: &'a str,
    /// Always "s3" for this project; parameterized because SigV4 scopes on it.
    pub service: &'a str,
    /// ISO8601 basic format, e.g. "20130524T000000Z". Supplied by the caller —
    /// the signer never reads a clock.
    pub timestamp: &'a str,
}

pub struct CanonicalRequest<'a> {
    pub method: &'a str,
    /// URI path exactly as it will appear on the wire (already percent-encoded;
    /// S3-style SigV4 does not normalize or double-encode paths).
    pub uri_path: &'a str,
    /// Query parameters, raw (encoding happens during canonicalization).
    pub query: &'a [(&'a str, &'a str)],
    /// Headers to sign, raw. Must include `host`; header auth must include
    /// `x-amz-date` matching the context timestamp.
    pub headers: &'a [(&'a str, &'a str)],
    /// Hex SHA-256 of the request body, or [`UNSIGNED_PAYLOAD`].
    pub payload_hash: &'a str,
}

pub struct Signature {
    pub signature: String,
    pub credential_scope: String,
    pub signed_headers: String,
}

/// Lowercased, sorted `name:trimmed-value\n` block plus the `;`-joined
/// signed-headers list.
fn canonicalize_headers(headers: &[(&str, &str)]) -> (String, String) {
    let mut pairs: Vec<(String, &str)> = headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim()))
        .collect();
    pairs.sort();
    let canonical: String = pairs
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let signed: Vec<&str> = pairs.iter().map(|(name, _)| name.as_str()).collect();
    (canonical, signed.join(";"))
}

pub fn sign(ctx: &SigningContext, req: &CanonicalRequest) -> Signature {
    let (canonical_headers, signed_headers) = canonicalize_headers(req.headers);
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        req.method,
        req.uri_path,
        canonical_query_string(req.query),
        canonical_headers,
        signed_headers,
        req.payload_hash,
    );
    let date = &ctx.timestamp[..8];
    let credential_scope = format!("{date}/{}/{}/aws4_request", ctx.region, ctx.service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{credential_scope}\n{}",
        ctx.timestamp,
        sha256_hex(canonical_request.as_bytes()),
    );
    let key = signing_key(
        &ctx.credentials.secret_access_key,
        date,
        ctx.region,
        ctx.service,
    );
    Signature {
        signature: hex::encode(hmac_sha256(&key, string_to_sign.as_bytes())),
        credential_scope,
        signed_headers,
    }
}

pub fn authorization_header(ctx: &SigningContext, sig: &Signature) -> String {
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        ctx.credentials.access_key_id, sig.credential_scope, sig.signed_headers, sig.signature,
    )
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
            hex::encode(&key),
            "dbb893acc010964918f1fd433add87c70e8b0db6be30c1fbeafefa5ec6ba8378"
        );
    }

    fn example_credentials() -> Credentials {
        Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string(),
        }
    }

    fn example_context(credentials: &Credentials) -> SigningContext<'_> {
        SigningContext {
            credentials,
            region: "us-east-1",
            service: "s3",
            timestamp: "20130524T000000Z",
        }
    }

    // AWS "Example: GET Object" vector.
    #[test]
    fn signs_get_object_request() {
        let credentials = example_credentials();
        let ctx = example_context(&credentials);
        let req = CanonicalRequest {
            method: "GET",
            uri_path: "/test.txt",
            query: &[],
            headers: &[
                ("Host", "examplebucket.s3.amazonaws.com"),
                ("Range", "bytes=0-9"),
                ("x-amz-content-sha256", EMPTY_PAYLOAD_SHA256),
                ("x-amz-date", "20130524T000000Z"),
            ],
            payload_hash: EMPTY_PAYLOAD_SHA256,
        };
        let sig = sign(&ctx, &req);
        assert_eq!(
            sig.signature,
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
        assert_eq!(
            sig.signed_headers,
            "host;range;x-amz-content-sha256;x-amz-date"
        );
        assert_eq!(sig.credential_scope, "20130524/us-east-1/s3/aws4_request");
        assert_eq!(
            authorization_header(&ctx, &sig),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    // AWS "Example: PUT Object" vector — pre-encoded path with `$`.
    #[test]
    fn signs_put_object_request() {
        let credentials = example_credentials();
        let ctx = example_context(&credentials);
        let payload_hash = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
        let req = CanonicalRequest {
            method: "PUT",
            uri_path: "/test%24file.text",
            query: &[],
            headers: &[
                ("Date", "Fri, 24 May 2013 00:00:00 GMT"),
                ("Host", "examplebucket.s3.amazonaws.com"),
                ("x-amz-content-sha256", payload_hash),
                ("x-amz-date", "20130524T000000Z"),
                ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
            ],
            payload_hash,
        };
        let sig = sign(&ctx, &req);
        assert_eq!(
            sig.signature,
            "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    // AWS "Example: GET Bucket Lifecycle" vector — empty-valued query key.
    #[test]
    fn signs_get_bucket_lifecycle_request() {
        let credentials = example_credentials();
        let ctx = example_context(&credentials);
        let req = CanonicalRequest {
            method: "GET",
            uri_path: "/",
            query: &[("lifecycle", "")],
            headers: &[
                ("Host", "examplebucket.s3.amazonaws.com"),
                ("x-amz-content-sha256", EMPTY_PAYLOAD_SHA256),
                ("x-amz-date", "20130524T000000Z"),
            ],
            payload_hash: EMPTY_PAYLOAD_SHA256,
        };
        assert_eq!(
            sign(&ctx, &req).signature,
            "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
        );
    }

    // AWS "Example: Get Bucket (List Objects)" vector — multiple query params.
    #[test]
    fn signs_list_objects_request() {
        let credentials = example_credentials();
        let ctx = example_context(&credentials);
        let req = CanonicalRequest {
            method: "GET",
            uri_path: "/",
            query: &[("max-keys", "2"), ("prefix", "J")],
            headers: &[
                ("Host", "examplebucket.s3.amazonaws.com"),
                ("x-amz-content-sha256", EMPTY_PAYLOAD_SHA256),
                ("x-amz-date", "20130524T000000Z"),
            ],
            payload_hash: EMPTY_PAYLOAD_SHA256,
        };
        assert_eq!(
            sign(&ctx, &req).signature,
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }
}
