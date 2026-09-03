import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../utils/roomState.js';
import { applySimpleDabaaqScore, canonicalScore, normalizeSessionName } from '../utils/scoreEngine.js';

test('magacyada waa la mideeyaa', () => {
  assert.equal(normalizeSessionName('  Cabdi   Noor '), 'CABDI NOOR');
});

test('net score wuxuu noqdaa wins ama fooros', () => {
  assert.deepEqual(canonicalScore(3), { wins: 3, fooros: 0 });
  assert.deepEqual(canonicalScore(-2), { wins: 0, fooros: 2 });
});

test('guuleyste caadi ah wuxuu helaa hal guul', () => {
  const room = createRoom({
    players: [{ id: 'a', name: 'Ali' }, { id: 'b', name: 'Ayaan' }],
  });
  const result = applySimpleDabaaqScore(room, 'Ali');
  assert.equal(result.scores.ALI.wins, 1);
  assert.equal(result.deltas.ALI.net, 1);
});