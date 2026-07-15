use wasm_bindgen::prelude::*;

pub mod manifest;
pub mod reconcile;
pub mod s3;
pub mod signer;

/// Returns the core crate version.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_matches_cargo_manifest() {
        assert_eq!(crate::version(), env!("CARGO_PKG_VERSION"));
    }
}
