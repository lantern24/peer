mod lsp;
pub mod monitor;
pub mod navigation;
pub mod repository;
pub mod service;
pub mod store;
pub mod theme;
pub mod types;

use sha2::{Digest, Sha256};
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub use service::Inspector;
pub use types::*;
