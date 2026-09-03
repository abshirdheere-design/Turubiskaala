import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const MAX_HISTORY_GAMES = 5000;

function emptyHistory() {
  return { games: [], players: {} };
}

function normalizePlayerName(name) {
  return String(name || '').trim().toUpperCase();
}

function normalizeHistory(value) {
  const source = value && typeof value === 'object' ? value : {};
  const games = Array.isArray(source.games)
    ? source.games.filter(game => game && typeof game === 'object').slice(-MAX_HISTORY_GAMES)
    : [];
  const players = {};

  // Rebuild the summary from the games when possible. This keeps the file
  // resilient if an older version only saved the game list.
  games.forEach(game => {
    const seen = new Set();
    (Array.isArray(game.players) ? game.players : []).forEach(player => {
      const name = String(player?.name || '').trim();
      const key = normalizePlayerName(name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      if (!players[key]) {
        players[key] = { name, gamesPlayed: 0, isBot: Boolean(player?.isBot) };
      }
      players[key].gamesPlayed += 1;
      if (player?.isBot) players[key].isBot = true;
    });
  });

  if (!games.length && source.players && typeof source.players === 'object') {
    Object.entries(source.players).forEach(([key, player]) => {
      const name = String(player?.name || key).trim();
      const normalizedKey = normalizePlayerName(name);
      if (!normalizedKey) return;
      players[normalizedKey] = {
        name,
        gamesPlayed: Math.max(0, Number(player?.gamesPlayed) || 0),
        isBot: Boolean(player?.isBot),
      };
    });
  }

  return { games, players };
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, filePath);
}

function readHistory(filePath) {
  try {
    if (!existsSync(filePath)) return emptyHistory();
    return normalizeHistory(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch (error) {
    console.error(`❌ Lama akhrin karo taariikhda guuleystayaasha:`, error.message || error);
    return emptyHistory();
  }
}

function publicSummary(state) {
  const games = [...state.games]
    .reverse()
    .map(game => ({
      id: game.id,
      endedAt: game.endedAt,
      winner: game.winner,
      winnerId: game.winnerId || null,
      xiiliTarget: game.xiiliTarget || null,
      players: game.players.map(player => ({
        name: player.name,
        isBot: Boolean(player.isBot),
      })),
    }));

  const players = Object.values(state.players)
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name))
    .map(player => ({
      name: player.name,
      gamesPlayed: player.gamesPlayed,
      isBot: Boolean(player.isBot),
    }));

  return {
    totalGames: games.length,
    games,
    players,
  };
}

export function createWinnerHistoryStore(filePath) {
  let state = readHistory(filePath);

  if (!existsSync(filePath)) {
    atomicWriteJson(filePath, state);
  }

  return {
    getSummary() {
      return publicSummary(state);
    },

    recordGame({ winnerName, winnerId = null, players = [], roomId = null, xiiliTarget = null, endedAt = new Date().toISOString() }) {
      const winner = String(winnerName || '').trim();
      if (!winner) return null;

      const cleanPlayers = [];
      const seen = new Set();
      players.forEach(player => {
        const name = String(player?.name || '').trim();
        const key = normalizePlayerName(name);
        if (!key || seen.has(key)) return;
        seen.add(key);
        cleanPlayers.push({
          name,
          isBot: Boolean(player?.isBot),
        });
      });

      // A completed game must include the winner in its participant list,
      // even if a caller accidentally omitted that player.
      if (!seen.has(normalizePlayerName(winner))) {
        cleanPlayers.push({ name: winner, isBot: false });
      }

      const record = {
        id: `game_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        endedAt,
        winner,
        winnerId,
        xiiliTarget: Number(xiiliTarget) || null,
        players: cleanPlayers,
        ...(roomId ? { roomId: String(roomId) } : {}),
      };

      state.games.push(record);
      if (state.games.length > MAX_HISTORY_GAMES) {
        state.games = state.games.slice(-MAX_HISTORY_GAMES);
      }

      // Recalculate totals after trimming so the summary always matches the
      // records that are actually retained on disk.
      state = normalizeHistory(state);
      atomicWriteJson(filePath, state);
      return record;
    },

    clear() {
      state = emptyHistory();
      atomicWriteJson(filePath, state);
      return publicSummary(state);
    },
  };
}