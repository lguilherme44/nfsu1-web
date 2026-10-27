//! JavaScript's `Map` where its order is seen (the results' and the friends lists' "least recently seen first", the
//! files written in that order): insertion order, a key set again keeps its place, a key deleted and set again goes
//! to the end.  `delete` and the move to the end cost O(log n), not O(n) as an `IndexMap::shift_remove` would
//! (stats.json keeps up to 100,000 personas, each race moves its players to the end).

use std::borrow::Borrow;
use std::collections::{BTreeMap, HashMap};
use std::hash::Hash;

pub struct OrderedMap<K, V> {
    at: HashMap<K, (u64, V)>,
    order: BTreeMap<u64, K>,
    next: u64,
}

impl<K: Hash + Eq + Clone, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        OrderedMap { at: HashMap::new(), order: BTreeMap::new(), next: 0 }
    }
}

impl<K: Hash + Eq + Clone, V> OrderedMap<K, V> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.at.len()
    }
    pub fn contains_key<Q: Hash + Eq + ?Sized>(&self, k: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.at.contains_key(k)
    }
    pub fn get<Q: Hash + Eq + ?Sized>(&self, k: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        self.at.get(k).map(|(_, v)| v)
    }
    pub fn get_mut<Q: Hash + Eq + ?Sized>(&mut self, k: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
    {
        self.at.get_mut(k).map(|(_, v)| v)
    }
    /// a value and its place in the order (a smaller place is earlier)
    pub fn get_placed<Q: Hash + Eq + ?Sized>(&self, k: &Q) -> Option<(u64, &V)>
    where
        K: Borrow<Q>,
    {
        self.at.get(k).map(|(seq, v)| (*seq, v))
    }
    /// `Map.set`: a new key at the end, a known one keeps its place
    pub fn insert(&mut self, k: K, v: V) {
        if let Some(e) = self.at.get_mut(&k) {
            e.1 = v;
            return;
        }
        let seq = self.next;
        self.next += 1;
        self.order.insert(seq, k.clone());
        self.at.insert(k, (seq, v));
    }
    /// `Map.delete`
    pub fn remove<Q: Hash + Eq + ?Sized>(&mut self, k: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        let (seq, v) = self.at.remove(k)?;
        self.order.remove(&seq);
        Some(v)
    }
    /// `m.delete(k); m.set(k, v)` with the same value: to the end
    pub fn move_to_end<Q: Hash + Eq + ?Sized>(&mut self, k: &Q)
    where
        K: Borrow<Q>,
    {
        let next = self.next;
        let Some(e) = self.at.get_mut(k) else { return };
        if let Some(key) = self.order.remove(&e.0) {
            e.0 = next;
            self.order.insert(next, key);
            self.next += 1;
        }
    }
    /// the oldest key
    pub fn first_key(&self) -> Option<&K> {
        self.order.values().next()
    }
    #[cfg(test)]
    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.order.values()
    }
    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.order.values().map(|k| &self.at[k].1)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.order.values().map(|k| (k, &self.at[k].1))
    }
    /// each entry in order, to change its value
    pub fn for_each_mut(&mut self, mut f: impl FnMut(&K, &mut V)) {
        for k in self.order.values() {
            if let Some(e) = self.at.get_mut(k) {
                f(k, &mut e.1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_js_map() {
        let mut m = OrderedMap::new();
        m.insert("a", 1);
        m.insert("b", 2);
        m.insert("c", 3);
        m.insert("a", 4);
        assert_eq!(m.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>(), [("a", 4), ("b", 2), ("c", 3)]);
        m.move_to_end("a");
        m.remove("b");
        m.insert("b", 5);
        assert_eq!(m.keys().copied().collect::<Vec<_>>(), ["c", "a", "b"]);
        assert_eq!(m.first_key(), Some(&"c"));
        assert_eq!(m.len(), 3);
    }
}
