// A cap on the connections a network relay serves at once (#304). Each one costs threads in a process outside the
// command's job object (sandbox-helper) or bounded only by the job's process limit (net-bridge), so a command that
// opens thousands of connections must not get thousands of threads. A connection over the cap is closed at once; the
// client sees it fail, as with a busy server, and may retry.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

// Package managers and browsers keep a few dozen connections open at most.
pub const MAX_CONNECTIONS: usize = 64;

#[derive(Clone, Default)]
pub struct Slots(Arc<AtomicUsize>);

// Held for the life of one connection; dropping it frees the slot.
pub struct Slot(Arc<AtomicUsize>);

impl Slots {
    pub fn take(&self) -> Option<Slot> {
        // Taken, then given back when over the cap: a moment's overcount only refuses a connection.
        let slot = Slot(self.0.clone());
        (self.0.fetch_add(1, Ordering::SeqCst) < MAX_CONNECTIONS).then_some(slot)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_at_most_the_cap_and_frees_a_slot_when_a_connection_ends() {
        let slots = Slots::default();
        let mut held: Vec<Slot> = (0..MAX_CONNECTIONS)
            .map(|_| slots.take().unwrap())
            .collect();
        assert!(slots.take().is_none());
        held.pop();
        held.push(slots.take().unwrap());
        assert!(slots.take().is_none());
        assert_eq!(held.len(), MAX_CONNECTIONS);
    }
}
