export function normalizeSessionName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function canonicalScore(net) {
  const value = Number.isFinite(Number(net)) ? Math.trunc(Number(net)) : 0;
  return {
    wins: Math.max(0, value),
    fooros: Math.max(0, -value),
  };
}

export function scoreNet(score) {
  return (Number(score?.wins) || 0) - (Number(score?.fooros) || 0);
}

export function ensureSessionScore(scores, name) {
  const displayName = String(name || '').trim();
  const key = normalizeSessionName(displayName);
  if (!key) return null;

  if (!scores[key]) {
    scores[key] = {
      ...canonicalScore(0),
      fooroOwners: [],
      displayName,
    };
  }

  scores[key].wins = Math.max(0, Number.parseInt(scores[key].wins, 10) || 0);
  scores[key].fooros = Math.max(0, Number.parseInt(scores[key].fooros, 10) || 0);
  scores[key].fooroOwners = Array.isArray(scores[key].fooroOwners)
    ? scores[key].fooroOwners.filter(Boolean).slice(0, scores[key].fooros)
    : [];
  scores[key].displayName ||= displayName;
  return scores[key];
}

export function fooroOwnersFor(score, fallbackOwner = null) {
  const count = Math.max(0, Number(score?.fooros) || 0);
  const owners = Array.isArray(score?.fooroOwners) ? score.fooroOwners.filter(Boolean) : [];
  while (fallbackOwner && owners.length < count) owners.push(fallbackOwner);
  return owners.slice(0, count);
}

export function applyWinnerScore(score) {
  if (Number(score.fooros) > 0) score.fooros--;
  else score.wins = (Number(score.wins) || 0) + 1;
  return score;
}

export function addScoreDelta(deltas, name, delta) {
  const key = normalizeSessionName(name);
  if (!key) return;
  deltas[key] ||= { wins: 0, fooros: 0, net: 0 };
  deltas[key].wins += delta.wins || 0;
  deltas[key].fooros += delta.fooros || 0;
  deltas[key].net += delta.net || 0;
}

export function applySimpleDabaaqScore(room, winnerName, victimName = null) {
  const scores = structuredClone(room.sessionScores || {});
  const before = structuredClone(scores);
  const winnerKey = normalizeSessionName(winnerName);
  const winner = ensureSessionScore(scores, winnerName);
  if (!winner) throw new Error('Guuleystaha lama helin.');

  const winnerBefore = scoreNet(winner);
  applyWinnerScore(winner);
  let winnerAfter = scoreNet(winner);
  let dabaaqType = null;
  let dabaaqPair = null;

  const pairIndex = (room.activeDabaaqPairs || []).findIndex(pair =>
    normalizeSessionName(pair.player1) === winnerKey ||
    normalizeSessionName(pair.player2) === winnerKey);
  if (pairIndex >= 0) {
    dabaaqPair = room.activeDabaaqPairs.splice(pairIndex, 1)[0];
    const otherName = normalizeSessionName(dabaaqPair.player1) === winnerKey
      ? dabaaqPair.player2
      : dabaaqPair.player1;
    const otherKey = normalizeSessionName(otherName);
    const other = ensureSessionScore(scores, otherName);
    dabaaqType = dabaaqPair.type === 'positive_positive' ? 'positive' : 'negative';

    if (dabaaqType === 'positive' && winnerBefore === 1 && scoreNet(other) >= 1) {
      winnerAfter = winnerBefore + 2;
      const otherNet = scoreNet(other) - 1;
      scores[otherKey] = { ...canonicalScore(otherNet), fooroOwners: fooroOwnersFor(other), displayName: other.displayName };
    } else if (dabaaqType === 'negative') {
      winnerAfter = 1;
      scores[otherKey] = { wins: 0, fooros: 2, fooroOwners: fooroOwnersFor(other), displayName: other.displayName };
    }
  }

  if (victimName && normalizeSessionName(victimName) !== winnerKey) {
    const victim = ensureSessionScore(scores, victimName);
    victim.fooros++;
    victim.fooroOwners = [...fooroOwnersFor(victim), winnerName].slice(0, victim.fooros);
  }

  scores[winnerKey] = {
    ...canonicalScore(winnerAfter),
    fooroOwners: fooroOwnersFor(winner).slice(0, canonicalScore(winnerAfter).fooros),
    displayName: winner.displayName,
  };
  room.sessionScores = scores;

  const deltas = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(scores)])) {
    const oldScore = before[key] || {};
    const newScore = scores[key] || {};
    const wins = (newScore.wins || 0) - (oldScore.wins || 0);
    const fooros = (newScore.fooros || 0) - (oldScore.fooros || 0);
    if (wins || fooros) addScoreDelta(deltas, newScore.displayName || key, { wins, fooros, net: wins - fooros });
  }

  room.ended = Object.values(scores).some(score => score.fooros >= (room.xiiliTarget || 5));
  return { scores, deltas, dabaaqType, dabaaqPair };
}