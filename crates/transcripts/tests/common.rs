#![allow(dead_code)]
use std::time::{Duration, Instant};

// Equivale a `vi.waitFor`: reintenta hasta que la condición se cumple o vence el plazo.
pub fn wait_for(timeout_ms: u64, mut cond: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if cond() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}
