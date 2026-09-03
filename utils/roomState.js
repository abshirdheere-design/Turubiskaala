import { randomUUID } from 'node:crypto';
import { canonicalScore, normalizeSessionName } from './scoreEngine.js';

export function createRoom({ id = randomUUID(), players = [], xiiliTarget = 5 } = {}) {
  if (players.length < 2) throw new Error('Room-ku wuxuu u baahan yahay ugu yaraan 2 ciyaaryahan.');

  const names = new Set();
  const sessionScores = {};
  for (const player of players) {
    const key = normalizeSessionName(player.name);
    if (!key || names.has(key)) throw new Error('Magacyada ciyaartoydu waa inay kala duwanaadaan.');
    names.add(key);
    sessionScores[key] = { ...canonicalScore(0), fooroOwners: [], displayName: player.name };
  }

  return {
    id,
    players,
    xiiliTarget: Number(xiiliTarget) === 10 ? 10 : 5,
    sessionScores,
    activeDabaaqPairs: [],
    gameStarted: false,
    ended: false,
  };
}

export function addPlayer(room, player) {
  const key = normalizeSessionName(player.name);
  if (!key || room.players.some(existing => normalizeSessionName(existing.name) === key)) {
    throw new Error('Ciyaaryahankan hore ayuu ugu jiraa room-ka.');
  }
  room.players.push(player);
  room.sessionScores[key] = { ...canonicalScore(0), fooroOwners: [], displayName: player.name };
  return room;
}

export function setActiveDabaaqPairs(room, pairs) {
  room.activeDabaaqPairs = Array.isArray(pairs) ? pairs : [];
  return room;
}