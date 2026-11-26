#![allow(dead_code)]
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

pub fn wait_for(cond: impl Fn() -> bool, msg: &str) {
    let t = Instant::now();
    while !cond() {
        assert!(t.elapsed() < Duration::from_secs(10), "timeout: {msg}");
        sleep(Duration::from_millis(20));
    }
}

#[derive(Default)]
pub struct Log {
    pub data: Mutex<Vec<(String, String)>>,
    pub exits: Mutex<Vec<(String, i32)>>,
}

impl Log {
    pub fn text(&self, key: &str) -> String {
        self.data.lock().unwrap().iter().filter(|(k, _)| k == key).map(|(_, d)| d.as_str()).collect()
    }
    pub fn chunks(&self, key: &str) -> Vec<String> {
        self.data.lock().unwrap().iter().filter(|(k, _)| k == key).map(|(_, d)| d.clone()).collect()
    }
    pub fn exits_of(&self, key: &str) -> Vec<i32> {
        self.exits.lock().unwrap().iter().filter(|(k, _)| k == key).map(|(_, c)| *c).collect()
    }
    pub fn wait_text(&self, key: &str, needle: &str) {
        wait_for(|| self.text(key).contains(needle), &format!("{needle:?} in {:?}", self.text(key)));
    }
}
