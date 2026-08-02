import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClipStore } from '../src/ClipStore';

const mkClip = (id: string, bytes = Buffer.from([1, 2, 3])) => ({
  id,
  from: 'base-1',
  label: 'Base',
  bytes,
  durationMs: 1000,
});

test('add then get returns the stored clip', () => {
  const store = new ClipStore();
  try {
    const added = store.add(mkClip('c1'));
    assert.equal(added.id, 'c1');
    assert.equal(added.from, 'base-1');
    assert.equal(store.size, 1);
    const got = store.get('c1');
    assert.ok(got);
    assert.equal(got!.durationMs, 1000);
    assert.deepEqual(got!.bytes, Buffer.from([1, 2, 3]));
  } finally {
    store.dispose();
  }
});

test('get returns undefined for unknown id', () => {
  const store = new ClipStore();
  try {
    assert.equal(store.get('nope'), undefined);
  } finally {
    store.dispose();
  }
});

test('expired clips are not returned (short ttl)', async () => {
  const store = new ClipStore(10 /*ms*/);
  try {
    store.add(mkClip('c1'));
    assert.ok(store.get('c1'));
    await new Promise((r) => setTimeout(r, 25));
    // Past the TTL: a read must not return the stale clip.
    assert.equal(store.get('c1'), undefined);
  } finally {
    store.dispose();
  }
});

test('overflow evicts oldest first (MAX_CLIPS)', () => {
  const store = new ClipStore(60_000);
  try {
    for (let i = 0; i < ClipStore.MAX_CLIPS + 5; i++) {
      store.add(mkClip('c' + i));
    }
    assert.equal(store.size, ClipStore.MAX_CLIPS);
    // The oldest five (c0..c4) should be gone; the newest (c24) should remain.
    assert.equal(store.get('c0'), undefined);
    assert.equal(store.get('c4'), undefined);
    assert.ok(store.get('c' + (ClipStore.MAX_CLIPS + 4)));
    assert.ok(store.get('c' + (ClipStore.MAX_CLIPS - 1)));
  } finally {
    store.dispose();
  }
});

test('delete removes a clip', () => {
  const store = new ClipStore();
  try {
    store.add(mkClip('c1'));
    store.delete('c1');
    assert.equal(store.get('c1'), undefined);
    assert.equal(store.size, 0);
  } finally {
    store.dispose();
  }
});
