import { applyDabaaqRound } from './dabaaq-engine.js';

function applyCorrectDabaaqScores(
  io,
  room,
  winnerName,
  providerName,
  victimName = null
) {
  const season = getXiiliSession(room.xiiliTarget || 5);

  const result = applyDabaaqRound({
    scores: room.sessionScores,
    dabaaqPairs: season.dabaaqPairs,
    activeDabaaqPairs: room.activeDabaaqPairs,
    winnerName,
    victimName,
    target: room.xiiliTarget || 5
  });

  room.sessionScores = result.scores;
  season.scores = result.scores;
  season.dabaaqPairs = result.remainingPairs;

  saveSessionsData();

  io.to(room.id).emit('updateScores', {
    sessionScores: room.sessionScores,
    xiiliTarget: room.xiiliTarget
  });

  return result;
}