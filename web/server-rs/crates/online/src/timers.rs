//! The host's own timers, as a queue on the host's thread.  Each is an [`Action`] naming what to do and for which
//! session or connection (by id: the handler checks that it still exists when the timer fires).  Times are on the
//! timer clock (`Clocks::timer`: monotonic in the server, a test's own in the tests), not on the lobby's `now()`,
//! the wall clock its rules read: the timers run on real time whatever `now` says, and a test moves each on its own.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use crate::aries::FieldMap;
use crate::lobby::LaterKey;
use crate::vhost::ConnId;

pub type TimerId = u64;

/// what a timer does when it fires
pub enum Action {
    /// the lobby's tick, every 5 s
    LobbyTick,
    /// a game's record to the game list, or a room's population (lobby.rs `later`)
    Later(LaterKey),
    /// the redirector's 30 s for its request
    RedirectorIdle(ConnId),
    /// the web pages' 15 s for a request
    HttpIdle(ConnId),
    /// EA Messenger's 60 s for a login
    BuddyLogin(u64),
    /// EA Messenger's AUTH tried again (the lobby login may finish a moment later)
    BuddyRetry(u64, FieldMap),
    /// a presence held back to at most one a second
    Presence(u64),
    /// the messages that waited for a persona, a moment after its friends list
    BuddyMail(u64),
    /// the friends lists' debounced save
    BuddySave,
}

/// a time in ms that orders (the queue never holds a NaN)
#[derive(Clone, Copy)]
struct At(f64);
impl PartialEq for At {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o).is_eq()
    }
}
impl Eq for At {}
impl PartialOrd for At {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for At {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&o.0)
    }
}

#[derive(Default)]
pub struct Timers {
    heap: BinaryHeap<Reverse<(At, TimerId)>>,
    live: HashMap<TimerId, Action>,
    next: TimerId,
}

impl Timers {
    /// a timer: `a` at time `at`; timers of the same time fire in the order they were set
    pub fn set(&mut self, at: f64, a: Action) -> TimerId {
        self.next += 1;
        let id = self.next;
        let at = if at.is_nan() { 0.0 } else { at };
        self.heap.push(Reverse((At(at), id)));
        self.live.insert(id, a);
        id
    }
    /// a timer ends.  A cleared timer's place in the queue goes once the queue is mostly such places: a client that
    /// opens and resets streams as fast as its budget lets it leaves one a stream (the Messenger's 60 s for a login,
    /// the redirector's 30 s), each until its time.  (Each compaction follows as many clears as there are live
    /// timers: O(1) a clear, all told.)
    pub fn clear(&mut self, id: TimerId) {
        if self.live.remove(&id).is_some() && self.heap.len() > 1024 && self.heap.len() > 2 * self.live.len() {
            let live = &self.live;
            self.heap.retain(|Reverse((_, id))| live.contains_key(id));
            self.heap.shrink_to(2 * self.heap.len().max(512));
        }
    }
    /// (tests) the places in the queue, the cleared timers' among them
    #[cfg(test)]
    pub fn queued(&self) -> usize {
        self.heap.len()
    }
    /// when the next live timer is due
    pub fn next_due(&mut self) -> Option<f64> {
        while let Some(Reverse((at, id))) = self.heap.peek() {
            if self.live.contains_key(id) {
                return Some(at.0);
            }
            self.heap.pop();
        }
        None
    }
    /// the next timer due by `now`, taken off the queue
    pub fn pop_due(&mut self, now: f64) -> Option<(TimerId, Action)> {
        let due = self.next_due()?;
        if due > now {
            return None;
        }
        let Reverse((_, id)) = self.heap.pop()?;
        self.live.remove(&id).map(|a| (id, a))
    }
}
