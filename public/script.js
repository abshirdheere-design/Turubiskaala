let socket;
let myName = '';
let myHand = [];
let isMyTurn = false;
let hasDrawn = false;
let pickedFromDiscard = false;
let isOpened = false;
let iHaveOpened = false;
let myOpenedSets = [];
let temporaryScore = 0;
let currentMinToOpen = 101;
let discardTop = null;
let stockCount = 0;
let players = [];
let currentTurnId = null;
let opponents = { left: null, top: null, right: null };
let tablePlayers = [];
let myScore = 0;
let myOpeningScore = 0;
let barrierHistory = [101];
let turnTimeLeft = 30;
let turnTimerInterval = null;
let dragStartIndex = null;
let waitingAutoTimer = null;
let waitingCountdown = 10;
let inGame = false;
let lastPickedDiscardId = null;

// ─── Xiili (Season) Fooro Tracking ────────────────────────────────────────────
let sessionFooros = {};   // fallback: { playerName: { fooros, wins } }
let serverSessionScores = {}; // Server-ka ka yimaada dhibcaha: { playerName: { wins, fooros } }
let sessionDabaaqPairs = [];
let xiiliTarget = 5;
let lastAppliedGameOverKey = '';
let lastAppliedGameOverAt = 0;

// ─── Persistent Score System ──────────────────────────────────────────────────
let myProfileName = null;
let myProfileData = null;
let latestLeaderboard = [];
let winnerHistoryData = { totalGames: 0, players: [], games: [] };

const SESSION_KEY = 't101_token';
const PROFILE_KEY = 't101_profile';
const SCORES_KEY  = 't101_sessionScores';
const TARGET_KEY  = 't101_xiiliTarget';

function escapeHistoryHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function formatHistoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Waqti aan la garanayn';
  return date.toLocaleString('so-SO', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function renderWinnerHistory(data = winnerHistoryData) {
  winnerHistoryData = {
    totalGames: Number(data?.totalGames) || 0,
    players: Array.isArray(data?.players) ? data.players : [],
    games: Array.isArray(data?.games) ? data.games : [],
  };

  const countEl = $('winner-history-count');
  const playersEl = $('winner-history-players');
  const gamesEl = $('winner-history-games');
  if (!countEl || !playersEl || !gamesEl) return;

  countEl.textContent = `${winnerHistoryData.totalGames} ciyaar${winnerHistoryData.totalGames === 1 ? '' : 'o'} dhammaatay`;

  playersEl.innerHTML = winnerHistoryData.players.length
    ? winnerHistoryData.players.map(player => `
        <div class="winner-history-row">
          <span class="winner-history-player-name">${escapeHistoryHtml(player.name)}${player.isBot ? ' 🤖' : ''}</span>
          <span class="winner-history-player-count">${Number(player.gamesPlayed) || 0} jeer</span>
        </div>
      `).join('')
    : '<div class="winner-history-empty">Weli ciyaar dhammaatay lama kaydin.</div>';

  gamesEl.innerHTML = winnerHistoryData.games.length
    ? winnerHistoryData.games.map((game, index) => {
        const players = (Array.isArray(game.players) ? game.players : [])
          .map(player => `${escapeHistoryHtml(player.name)}${player.isBot ? ' 🤖' : ''}`)
          .join(', ');
        return `
          <div class="winner-history-game">
            <div>
              <div><span style="color:#888">#${winnerHistoryData.totalGames - index}</span> <span class="winner-history-game-winner">${escapeHistoryHtml(game.winner)}</span> baa guuleystay</div>
              <div class="winner-history-game-players">${players || 'Ciyaartoyda lama hayo'}</div>
            </div>
            <span class="winner-history-game-date">${escapeHistoryHtml(formatHistoryDate(game.endedAt))}</span>
          </div>
        `;
      }).join('')
    : '<div class="winner-history-empty">Guuleystayaal weli ma jiraan.</div>';
}

async function loadWinnerHistory() {
  const countEl = $('winner-history-count');
  try {
    const response = await fetch('/api/winner-history', { cache: 'no-store' });
    if (!response.ok) throw new Error('history request failed');
    const data = await response.json();
    renderWinnerHistory(data);
  } catch (error) {
    if (countEl) countEl.textContent = 'Taariikhda lama soo qaadi karin';
  }
}

async function clearWinnerHistory() {
  if (!winnerHistoryData.totalGames) return;
  const confirmed = window.confirm(
    'Ma hubtaa inaad tirtirayso dhammaan ciyaarihii iyo tiradii ciyaartoyda? Tallaabadan lama soo celin karo.'
  );
  if (!confirmed) return;

  const button = $('btn-clear-winner-history');
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/winner-history', { method: 'DELETE' });
    if (!response.ok) throw new Error('history delete failed');
    renderWinnerHistory(await response.json());
    showNotification('Taariikhda ciyaaraha waa la tirtiray.', 3000);
  } catch (error) {
    showNotification('Taariikhda lama tirtiri karin.', 3000);
  } finally {
    if (button) button.disabled = false;
  }
}

function saveSessionScores() {
  try {
    const source = Object.keys(serverSessionScores || {}).length ? serverSessionScores : sessionFooros;
    localStorage.setItem(SCORES_KEY, JSON.stringify(normalizeScoreMap(source) || {}));
    localStorage.setItem(TARGET_KEY, String(xiiliTarget || 5));
  } catch (e) { /* ignore quota */ }
}
function loadSessionScores() {
  try {
    const raw = localStorage.getItem(SCORES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        setSessionScores(parsed);
      }
    }
    const t = parseInt(localStorage.getItem(TARGET_KEY) || '', 10);
    if (t === 5 || t === 10) xiiliTarget = t;
  } catch (e) { /* ignore */ }
}
function clearSessionScores() {
  try {
    localStorage.removeItem(SCORES_KEY);
    localStorage.removeItem(TARGET_KEY);
  } catch (e) {}
}

function normalizeName(name) {
  return String(name || '').trim().toUpperCase();
}

function normalizeScoreEntry(value) {
  return {
    wins: Math.max(0, parseInt(value && value.wins, 10) || 0),
    fooros: Math.max(0, parseInt(value && value.fooros, 10) || 0),
    fooroOwners: Array.isArray(value && value.fooroOwners)
      ? value.fooroOwners.filter(Boolean)
      : [],
  };
}

function normalizeScoreMap(scoreMap) {
  
  const normalized = {};
  if (!scoreMap || typeof scoreMap !== 'object') return normalized;
  Object.entries(scoreMap).forEach(([name, value]) => {
    const key = normalizeName(name);
    if (!key) return;
    const entry = normalizeScoreEntry(value);
    if (!normalized[key]) {
      normalized[key] = {
        wins: 0,
        fooros: 0,
        fooroOwners: [],
        displayName: (value && value.displayName) || String(name).trim()
      };
    }
    normalized[key].wins = Math.max(normalized[key].wins, entry.wins);
    normalized[key].fooros = Math.max(normalized[key].fooros, entry.fooros);
    normalized[key].fooroOwners = [
      ...normalized[key].fooroOwners,
      ...entry.fooroOwners
    ].slice(0, normalized[key].fooros);
  });
  return normalized;
}

function mergeScoreMaps(...maps) {
  const merged = {};
  maps.forEach(map => {
    const cleanMap = normalizeScoreMap(map);
    Object.entries(cleanMap).forEach(([key, value]) => {
      if (!merged[key]) {
        merged[key] = {
          wins: 0,
          fooros: 0,
          fooroOwners: [],
          displayName: value.displayName || key
        };
      }
      merged[key].wins = Math.max(merged[key].wins || 0, value.wins || 0);
      merged[key].fooros = Math.max(merged[key].fooros || 0, value.fooros || 0);
      merged[key].fooroOwners = [
        ...(merged[key].fooroOwners || []),
        ...(value.fooroOwners || [])
      ].slice(0, merged[key].fooros);
      if (value.displayName) merged[key].displayName = value.displayName;
    });
  });
  return merged;
}

function getMergedSessionScores() {
  // MUHIIM: Marka server-ku dhibco soo diro, ISAGA KELIYA ayaa la aaminayaa.
  // Hore waxaa la isticmaali jiray Math.max(local, server) taasoo dib u soo
  // celin jirtay dhibco duug ah oo browser-ka ku hadhay (tusaale Abshir +2
  // halkii uu ahaan lahaa +1). Kaydka maxalliga ah waa fallback offline oo kaliya.
  const visiblePlayers = {};
  (players || []).forEach(p => {
    if (p && p.name) {
      const key = normalizeName(p.name);
      visiblePlayers[key] = {
        wins: 0,
        fooros: 0,
        fooroOwners: [],
        displayName: p.name
      };
    }
  });

  const authoritative = normalizeScoreMap(serverSessionScores);
  const hasServerScores = Object.keys(authoritative).length > 0;
  const visibleKeys = new Set(Object.keys(visiblePlayers));
  if (!visibleKeys.size) return {};

  // Haddii qolka la galay, ha soo bandhigin score ku kaydsan browser-ka
  // ama server-ka oo ka yimid miis kale. Tani waxay ka dhigaysaa panel-ka
  // mid ku kooban afarta qof ee miiskan.
  const keepVisibleOnly = map => {
    if (!visibleKeys.size) return map;
    return Object.fromEntries(
      Object.entries(map).filter(([key]) => visibleKeys.has(key))
    );
  };

  if (!hasServerScores) {
    // Offline / weli lama sync-gareyn: kayd maxalli ah oo kaliya.
    return keepVisibleOnly(mergeScoreMaps(sessionFooros, visiblePlayers));
  }

  // Server = source of truth. Ciyaartoyda muuqda ee aan server-ku soo sheegin
  // waxay ku bilaabmayaan 0, mana laha wax dhibco duug ah.
  const result = {};
  Object.entries(authoritative).forEach(([key, value]) => {
    if (visibleKeys.size && !visibleKeys.has(key)) return;
    result[key] = {
      wins: value.wins || 0,
      fooros: value.fooros || 0,
      fooroOwners: value.fooroOwners || [],
      displayName: value.displayName || key
    };
  });
  Object.entries(visiblePlayers).forEach(([key, value]) => {
    if (!result[key]) {
      result[key] = {
        wins: 0,
        fooros: 0,
        fooroOwners: [],
        displayName: value.displayName
      };
    }
    else result[key].displayName = value.displayName || result[key].displayName;
  });
  return result;
}

function setSessionScores(scoreMap) {
  const authoritative = normalizeScoreMap(scoreMap);
  sessionFooros = authoritative;
  serverSessionScores = normalizeScoreMap(authoritative);
  saveSessionScores();
  return authoritative;
}

function ensureSessionPlayer(name) {
  const key = normalizeName(name);
  if (!key) return;
  const display = String(name).trim();
  if (!sessionFooros[key]) sessionFooros[key] = { wins: 0, fooros: 0, displayName: display };
  if (!serverSessionScores[key]) serverSessionScores[key] = { wins: 0, fooros: 0, displayName: display };
}

function correctServerScoresForEqualPositiveDabaaq(scoreMap, winnerId, fooroTarget, allGamePlayers, dabaaqType) {
  const corrected = normalizeScoreMap(scoreMap);
  if (dabaaqType === 'negative' || !winnerId || !fooroTarget || !allGamePlayers?.length) return corrected;

  const winner = allGamePlayers.find(p => p && p.id === winnerId);
  if (!winner) return corrected;

  const winnerKey = normalizeName(winner.name);
  const victimKey = normalizeName(fooroTarget.name);
  const previousWinner = sessionFooros[winnerKey] || { wins: 0, fooros: 0 };
  const previousVictim = sessionFooros[victimKey] || { wins: 0, fooros: 0 };
  const winnerNet = (previousWinner.wins || 0) - (previousWinner.fooros || 0);
  if (winnerNet <= 0) return corrected;

  const equalPlayer = allGamePlayers.find(p => {
    if (!p || p.id === winnerId || p.id === fooroTarget.id) return false;
    const key = normalizeName(p.name);
    const previous = sessionFooros[key] || { wins: 0, fooros: 0 };
    return (previous.wins || 0) - (previous.fooros || 0) === winnerNet;
  });
  if (!equalPlayer) return corrected;

  const equalKey = normalizeName(equalPlayer.name);
  const previousEqual = sessionFooros[equalKey] || { wins: 0, fooros: 0 };
  const equalNet = (previousEqual.wins || 0) - (previousEqual.fooros || 0);

  corrected[winnerKey] = {
    ...(corrected[winnerKey] || {}),
    displayName: winner.name,
    wins: (previousWinner.wins || 0) + equalNet + 1,
    fooros: 0
  };
  corrected[equalKey] = {
    ...(corrected[equalKey] || {}),
    displayName: equalPlayer.name,
    wins: previousEqual.fooros || 0,
    fooros: previousEqual.fooros || 0
  };
  corrected[victimKey] = {
    ...(corrected[victimKey] || {}),
    displayName: fooroTarget.name,
    wins: previousVictim.wins || 0,
    fooros: (previousVictim.fooros || 0) + (previousWinner.fooros || 0) + 1
  };

  return corrected;
}

const POINT_VALUES = {
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'j': 10, 'q': 10, 'k': 10, 'a': 11,
  'J': 10, 'Q': 10, 'K': 10, 'A': 11
};

function $(id) { return document.getElementById(id); }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(`${name}-screen`);
  if (el) el.classList.add('active');
  const fp = $('fooro-panel');
  if (fp) fp.style.display = 'block';
  updateFooroPanel();
}

const FOORO_MINIMIZED_KEY = 't101_fooroPanelMinimized';

function setFooroPanelMinimized(minimized) {
  const panel = $('fooro-panel');
  const list = $('fooro-list');
  if (!panel || !list) return;

  const isMinimized = Boolean(minimized);
  panel.dataset.minimized = isMinimized ? 'true' : 'false';
  list.style.display = isMinimized ? 'none' : '';

  const toggle = panel.querySelector(
    '#fooro-toggle-btn, #fooro-minimize, #fooro-toggle, [data-fooro-toggle], [data-action="toggle-fooro"], .fooro-minimize, .fooro-toggle'
  );
  if (toggle) {
    toggle.textContent = isMinimized ? '+' : '−';
    toggle.setAttribute('aria-label', isMinimized ? 'Muuji Fooro panel' : 'Yaree Fooro panel');
    toggle.setAttribute('title', isMinimized ? 'Muuji Fooro panel' : 'Yaree Fooro panel');
  }

  try {
    localStorage.setItem(FOORO_MINIMIZED_KEY, isMinimized ? '1' : '0');
  } catch (e) {}
}

function toggleFooroPanel() {
  const panel = $('fooro-panel');
  if (!panel) return;
  setFooroPanelMinimized(panel.dataset.minimized !== 'true');
}

function setupFooroPanelControls() {
  const panel = $('fooro-panel');
  const list = $('fooro-list');
  if (!panel || !list) return;

  let toggle = panel.querySelector(
    '#fooro-toggle-btn, #fooro-minimize, #fooro-toggle, [data-fooro-toggle], [data-action="toggle-fooro"], .fooro-minimize, .fooro-toggle'
  );

  // Haddii HTML-ku uusan lahayn button, mid shaqaynaya samee. Waxa uu
  // bannaanka kaga jiraa fooro-list si updateFooroPanel() uusan u tirtirin.
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.id = 'fooro-minimize';
    toggle.type = 'button';
    toggle.textContent = '−';
    toggle.style.cssText = 'position:absolute;right:6px;top:4px;z-index:2;border:0;background:transparent;color:#f1c40f;font-size:18px;line-height:18px;cursor:pointer;padding:0 4px;';
    if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
    panel.appendChild(toggle);
  }

  if (!toggle.dataset.fooroBound) {
    toggle.dataset.fooroBound = 'true';
    toggle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setFooroPanelMinimized(panel.dataset.minimized !== 'true');
    });
  }

  let saved = false;
  try { saved = localStorage.getItem(FOORO_MINIMIZED_KEY) === '1'; } catch (e) {}
  setFooroPanelMinimized(saved);
}

function showNotification(msg, duration = 4000) {
  let container = document.getElementById('notification-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'notification-container';
    document.body.appendChild(container);
  }
  const existing = [...container.querySelectorAll('.notif-card')]
    .find(n => n.dataset.msg === msg);
  if (existing) {
    clearTimeout(Number(existing.dataset.timer));
    const t = setTimeout(() => existing.remove(), duration);
    existing.dataset.timer = t;
    existing.classList.remove('notif-shake');
    void existing.offsetWidth;
    existing.classList.add('notif-shake');
    return;
  }
  const el = document.createElement('div');
  el.className = 'notif-card';
  el.dataset.msg = msg;
  el.innerHTML = `<strong>📢 ${msg}</strong>`;
  container.appendChild(el);
  const timer = setTimeout(() => { el.remove(); }, duration);
  el.dataset.timer = timer;
}

function distributeAllCardsAnimated(myCards, opponentCounts, onDone) {
  const container = $('table-area');
  const handContainer = $('hand-cards');
  if (!container || !handContainer) return;
  handContainer.innerHTML = '';
  const positions = { top: { x: 0, y: -220 }, left: { x: -360, y: 0 }, right: { x: 360, y: 0 } };
  const total = myCards.length;
  const opNames = ['right', 'top', 'left'];
  let delay = 0;
  const step = 100;

  opNames.forEach(pos => {
    const count = opponentCounts[pos] || 14;
    const tx = positions[pos].x, ty = positions[pos].y;
    for (let i = 0; i < count; i++) {
      const d = delay;
      setTimeout(() => {
        const flying = document.createElement('div');
        flying.className = 'card-deal';
        flying.style.setProperty('--targetX', `${tx}px`);
        flying.style.setProperty('--targetY', `${ty}px`);
        container.appendChild(flying);
        setTimeout(() => flying.remove(), 650);
      }, d);
      delay += step;
    }
  });

  myCards.forEach((card, index) => {
    const d = delay;
    setTimeout(() => {
      const flying = document.createElement('div');
      flying.className = 'card-deal';
      const targetX = -((total - 1) * 36) + (index * 72);
      flying.style.setProperty('--targetX', `${targetX}px`);
      flying.style.setProperty('--targetY', '260px');
      container.appendChild(flying);
      setTimeout(() => {
        flying.remove();
        if (index === total - 1) {
          renderHand();
          if (socket) socket.emit('animation_finished');
          if (onDone) onDone();
        }
      }, 650);
    }, d);
    delay += step;
  });
}

function startTurnTimer() {
  clearInterval(turnTimerInterval);
  turnTimeLeft = 30;
  renderHeader();
  turnTimerInterval = setInterval(() => {
    turnTimeLeft = Math.max(0, turnTimeLeft - 1);
    renderHeader();
    if (turnTimeLeft === 0) clearInterval(turnTimerInterval);
  }, 1000);
}

function getCardValue(card) {
  const map = { a: 14, k: 13, q: 12, j: 11, A: 14, K: 13, Q: 12, J: 11 };
  const v = String(card.value);
  return map[v] || parseInt(v);
}

function cardPoints(card) {
  return POINT_VALUES[String(card.value)] || 0;
}

/*
 * Find the best disjoint partition of the selected cards.
 *
 * A greedy pass is not enough here. For example, with
 * 6c, 7c, 8c and three other 7s, taking the four 7s first steals 7c
 * and incorrectly leaves 6c (and 8c) outside a valid run. We enumerate
 * the possible runs and same-rank groups, then choose the combination
 * that covers the most cards. This also lets 7c stay in 6c-7c-8c while
 * the other three 7s form their own group.
 */
function findBestGroupPartition(cards) {
  const n = cards.length;
  if (!n) return { groups: [], remaining: [] };

  const candidates = [];
  const addCandidate = (indices, kind) => {
    if (indices.length < 3) return;
    const mask = indices.reduce((value, index) => value | (1 << index), 0);
    if (!candidates.some(candidate => candidate.mask === mask)) {
      candidates.push({ indices, mask, kind });
    }
  };

  const choicesProduct = (choices, at = 0, picked = []) => {
    if (at === choices.length) {
      addCandidate([...picked], 'run');
      return;
    }
    choices[at].forEach(index => {
      picked.push(index);
      choicesProduct(choices, at + 1, picked);
      picked.pop();
    });
  };

  // Generate every consecutive same-suit window, including shorter
  // windows of a longer run so that a bridge card can belong to a set.
  ['♠', '♥', '♣', '♦'].forEach(suit => {
    for (let start = 6; start <= 12; start++) {
      for (let end = start + 2; end <= 14; end++) {
        const choices = [];
        let complete = true;
        for (let value = start; value <= end; value++) {
          const matching = cards
            .map((card, index) => ({ card, index }))
            .filter(({ card }) => card.suit === suit && getCardValue(card) === value)
            .map(({ index }) => index);
          if (!matching.length) {
            complete = false;
            break;
          }
          choices.push(matching);
        }
        if (complete) choicesProduct(choices);
      }
    }
  });

  // Generate same-rank groups with distinct suits. Do not blindly take
  // the first four cards: each possible card choice may be needed by a run.
  [...new Set(cards.map(card => card.value))].forEach(value => {
    const bySuit = new Map();
    cards.forEach((card, index) => {
      if (card.value === value) {
        const list = bySuit.get(card.suit) || [];
        list.push(index);
        bySuit.set(card.suit, list);
      }
    });
    const suits = [...bySuit.keys()];
    // Build same-rank candidates directly so duplicate cards of one suit
    // are also handled without mixing suits.
    const addRankChoices = (selectedSuits, at = 0, picked = []) => {
      if (at === selectedSuits.length) {
        const mask = picked.reduce((result, index) => result | (1 << index), 0);
        if (!candidates.some(candidate => candidate.mask === mask)) {
          candidates.push({ indices: [...picked], mask, kind: 'rank' });
        }
        return;
      }
      (bySuit.get(selectedSuits[at]) || []).forEach(index => {
        picked.push(index);
        addRankChoices(selectedSuits, at + 1, picked);
        picked.pop();
      });
    };
    const chooseRankSuits = (at, picked) => {
      if (picked.length >= 3) addRankChoices(picked);
      if (picked.length === 4) return;
      for (let i = at; i < suits.length; i++) {
        chooseRankSuits(i + 1, [...picked, suits[i]]);
      }
    };
    chooseRankSuits(0, []);
  });

  const candidatesByIndex = Array.from({ length: n }, () => []);
  candidates.forEach(candidate => {
    candidate.indices.forEach(index => candidatesByIndex[index].push(candidate));
  });

  const better = (a, b) => {
    if (a.covered !== b.covered) return a.covered > b.covered ? a : b;
    if (a.fourPlus !== b.fourPlus) return a.fourPlus > b.fourPlus ? a : b;
    if (a.runCards !== b.runCards) return a.runCards > b.runCards ? a : b;
    if (a.longestRun !== b.longestRun) return a.longestRun > b.longestRun ? a : b;
    return a.groups.length <= b.groups.length ? a : b;
  };
  const memo = new Map();
  const solve = usedMask => {
    if (memo.has(usedMask)) return memo.get(usedMask);
    let firstUnused = -1;
    for (let index = 0; index < n; index++) {
      if (!(usedMask & (1 << index))) {
        firstUnused = index;
        break;
      }
    }
    if (firstUnused === -1) {
      const empty = { covered: 0, fourPlus: 0, runCards: 0, longestRun: 0, groups: [] };
      memo.set(usedMask, empty);
      return empty;
    }

    // Leaving a card unused is allowed; it is compared against every
    // possible group containing that card.
    let best = solve(usedMask | (1 << firstUnused));
    candidatesByIndex[firstUnused].forEach(candidate => {
      if (candidate.mask & usedMask) return;
      const rest = solve(usedMask | candidate.mask);
      const option = {
        covered: rest.covered + candidate.indices.length,
        fourPlus: rest.fourPlus + (candidate.indices.length >= 4 ? 1 : 0),
        runCards: rest.runCards + (candidate.kind === 'run' ? candidate.indices.length : 0),
        longestRun: Math.max(
          rest.longestRun,
          candidate.kind === 'run' ? candidate.indices.length : 0,
        ),
        groups: [
          candidate.indices.map(index => cards[index]),
          ...rest.groups,
        ],
      };
      best = better(option, best);
    });
    memo.set(usedMask, best);
    return best;
  };

  const result = solve(0);
  const groupedIds = new Set(result.groups.flat().map(card => card.id));
  return {
    validGroups: result.groups,
    remaining: cards.filter(card => !groupedIds.has(card.id)),
  };
}

function autoSplitIntoGroups(cards) {
  return findBestGroupPartition(cards).validGroups;
}

function findValidGroups(cards) {
  return findBestGroupPartition(cards);
}

function applyFooroLogic(winnerId, providerId, allPlayers) {
  if (!allPlayers || allPlayers.length === 0) return null;

  // Hoosgale/Batuuto waa bartilmaameedka tooska ah ee foorada.
  const hoosgalePlayer = allPlayers.find(p => p.id !== winnerId && p.hoosgale);
  const hoosgaleId = hoosgalePlayer?.id || null;
  if (hoosgalePlayer) {
    return {
      ...hoosgalePlayer,
      provider: null,
      providerIndex: -1,
      winner: allPlayers.find(x => x.id === winnerId),
      targetIndex: allPlayers.findIndex(p => p.id === hoosgalePlayer.id),
      handCount: (hoosgalePlayer.hand || []).length,
      handPoints: (hoosgalePlayer.hand || []).reduce((s, c) => s + (c.points || 0), 0)
    };
  }
  const canReceiveFooro = p =>
    p &&
    p.id !== winnerId &&
    !p.isOpened &&
    !p.isCleared &&
    !p.hasPassed;

  let provIdx = allPlayers.findIndex(p => p.id === providerId);
  const providerKnown = provIdx !== -1;
  if (!providerKnown) {
    const winnerIdx = allPlayers.findIndex(p => p.id === winnerId);
    if (winnerIdx === -1) return null;
    provIdx = (winnerIdx - 1 + allPlayers.length) % allPlayers.length;
  }

  // 2. Raadi qofka aan deganayn ee u dhow xagga dambe ee bixiyaha (provider)
  for (let i = 0; i < allPlayers.length; i++) {
    const idx = ((provIdx - i) % allPlayers.length + allPlayers.length) % allPlayers.length;
    const p = allPlayers[idx];
    if (canReceiveFooro(p)) {
      return {
        ...p,
        provider: providerKnown ? allPlayers[provIdx] : null,
        providerIndex: providerKnown ? provIdx : -1,
        winner: allPlayers.find(x => x.id === winnerId),
        targetIndex: idx,
        handCount: (p.hand || []).length,
        handPoints: (p.hand || []).reduce((s, c) => s + (c.points || 0), 0)
      };
    }
  }

  // 3. Haddii ay dhacdo in dadka oo dhan furan yihiin ama ay siman yihiin, qaado kan dhibcaha ugu badan haysta
  const winnerIdxForTie = allPlayers.findIndex(p => p.id === winnerId);
  const others = allPlayers.filter(p => p.id !== winnerId);

  if (winnerIdxForTie !== -1 && others.length > 0) {
    const withPoints = others.map(p => ({
      player: p,
      points: (p.hand || []).reduce((s, c) => s + (c.points || 0), 0)
    }));
    const maxPoints = Math.max(...withPoints.map(x => x.points));
    const topCandidates = withPoints.filter(x => x.points === maxPoints);

    let target;
    if (topCandidates.length === 1) {
      target = topCandidates[0].player;
      } else {
      for (let i = 1; i <= allPlayers.length; i++) {
        const idx = (winnerIdxForTie + i) % allPlayers.length;
          if (canReceiveFooro(allPlayers[idx])) { target = allPlayers[idx]; break; }
      }
    }

    if (target) {
      const targetIdx = allPlayers.findIndex(p => p.id === target.id);
      return {
        ...target,
        provider: providerKnown ? allPlayers[provIdx] : null,
        providerIndex: providerKnown ? provIdx : -1,
        winner: allPlayers.find(x => x.id === winnerId),
        targetIndex: targetIdx,
        handCount: (target.hand || []).length,
        handPoints: (target.hand || []).reduce((s, c) => s + (c.points || 0), 0)
      };
    }
  }
  
  // Fallback: Haddii kale soo celi qofkii ugu horreeyey ee aan guuleystayn si aysan u noqon null
  const fallbackTarget = others.find(p => !p.isCleared) || others[0];
  if (fallbackTarget) {
    return {
      ...fallbackTarget,
      provider: providerKnown ? allPlayers[provIdx] : null,
      providerIndex: providerKnown ? provIdx : -1,
      winner: allPlayers.find(x => x.id === winnerId),
      targetIndex: allPlayers.findIndex(p => p.id === fallbackTarget.id),
      handCount: (fallbackTarget.hand || []).length,
      handPoints: (fallbackTarget.hand || []).reduce((s, c) => s + (c.points || 0), 0)
    };
  }

  return null;
}

function makeCard(card, size, opts = {}) {
  const el = document.createElement('div');
  const isRed = ['♥', '♦'].includes(card.suit);
  const isFromDiscard = !!card.fromDiscard;

  el.className =
    `card ${size} ` +
    (opts.selected ? ' selected' : '') +
    (opts.overlap ? ' overlap' : '') +
    (isRed ? ' red-suit' : ' black-suit') +
    (isFromDiscard ? ' badda-card' : '');

  const cv = document.createElement('div');
  cv.className = 'cv';
  cv.textContent = card.value;

  const cs = document.createElement('div');
  cs.className = 'cs';
  cs.textContent = card.suit;

  const cvBot = document.createElement('div');
  cvBot.className = 'cv-bot';
  cvBot.textContent = card.value;

  el.appendChild(cv);
  el.appendChild(cs);
  el.appendChild(cvBot);

  if (isFromDiscard) {
    const badge = document.createElement('span');
    badge.className = 'discard-badge';
    badge.textContent = '★';
    el.appendChild(badge);
  }
  return el;
}

function makeCardBack(size) {
  const el = document.createElement('div');
  el.className = `card-back-${size}`;
  return el;
}

function renderHeader() {
  const hdrName = $('hdr-name'), hdrScore = $('hdr-score'), turnEl = $('hdr-turn');
  if (!hdrName || !hdrScore || !turnEl) return;
  hdrName.textContent = myName;
  
  if (isMyTurn) {
    turnEl.textContent = `DOORKAAGA (${turnTimeLeft}s)`;
    turnEl.className = 'hdr-turn-active';
  } else {
    turnEl.textContent = 'Sugaya...';
    turnEl.className = 'hdr-turn-idle';
  }
  const badge = $('hdr-opened-badge');
  if (badge) { if (isOpened) badge.classList.remove('hidden'); else badge.classList.add('hidden'); }
  const btnPause = $('btn-pause');
  if (btnPause) {
    btnPause.style.display = isMyTurn ? 'inline-block' : 'none';
    if (pickedFromDiscard && !isOpened) {
      btnPause.textContent = 'Soo Celi'; btnPause.style.background = '#f39c12';
    } else if (btnPause.dataset.paused === 'true') {
      btnPause.textContent = 'Fasax'; btnPause.style.background = '#f39c12';
    } else {
      btnPause.textContent = 'Isuga'; btnPause.style.background = '';
    }
  }
}

function renderHand() {
  const container = $('hand-cards');
  if (!container) return;
  container.innerHTML = '';
  myHand.forEach((card, idx) => {
    const el = makeCard(card, 'md', { selected: card.selected });
    if (card.fromDiscard) {
      el.style.border = '3px solid #ffcc00';
      el.style.boxShadow = '0 0 12px #ffcc00';
      el.style.borderRadius = '8px';
    }
    el.addEventListener('click', () => toggleCard(idx));
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragStartIndex = idx;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.style.opacity = '0.4', 0);
    });
    el.addEventListener('dragend', () => {
      el.style.opacity = '';
      dragStartIndex = null;
      document.querySelectorAll('.opened-set').forEach(s => { s.classList.remove('drop-target', 'drop-invalid'); });
    });
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', () => handleDrop(idx));
    container.appendChild(el);
  });

  const selScore = myHand.filter(c => c.selected).reduce((s, c) => s + cardPoints(c), 0);
  const selScoreEl = $('sel-score');
  if (selScoreEl) selScoreEl.textContent = selScore;

  const minOpenEl = $('min-open-label');
  if (minOpenEl) {
    if (isOpened) {
      const histParts = barrierHistory.map((v, i) => {
        if (i === barrierHistory.length - 1 && barrierHistory.length > 1) return `<span style="color:#e74c3c;font-weight:bold;">${v}</span>`;
        if (i === 1 && barrierHistory.length === 3) return `<span style="color:#2ecc71;font-weight:bold;">${v}</span>`;
        return `<span style="color:#bdc3c7;">${v}</span>`;
      });
      const histDisplay = histParts.join(' <span style="color:#666;">/</span> ');
      minOpenEl.innerHTML = `<span style="font-size:11px;color:#bdc3c7;">Xeerka:</span> ${histDisplay} <span style="font-size:11px;color:#bdc3c7;margin-left:4px;">— kale laga rabo: <b style="color:#e74c3c;">${currentMinToOpen}+</b></span>`;
    } else {
      minOpenEl.innerHTML = `U baahan: <span style="color: #f1c40f; font-weight: bold;">${currentMinToOpen}</span> <span style="font-size: 11px; color: #bdc3c7;">dhibco si aad u degto</span>`;
    }
  }

  const btnDhigo = $('btn-dhigo'), btnTuur = $('btn-tuur');
  if (btnDhigo) btnDhigo.disabled = !isMyTurn;
  if (btnTuur) btnTuur.disabled = !isMyTurn;
}

function canMeelGali(card, set) {
  if (!set || set.length < 3) return false;
  const allSameSuit = set.every(c => c && c.suit === card.suit);
  if (allSameSuit) {
    const vals = set.map(c => getCardValue(c)).sort((a, b) => a - b);
    const cv = getCardValue(card);
    if (cv === vals[0] - 1 || cv === vals[vals.length - 1] + 1) return true;
  }
  const allSameVal = set.every(c => c && c.value === card.value);
  const suitAlreadyIn = set.some(c => c && c.suit === card.suit);
  if (allSameVal && !suitAlreadyIn && set.length < 4) return true;
  return false;
}

function makeDraggableSet(set, setIdx, targetPlayerId) {
  const setDiv = document.createElement('div');
  setDiv.className = 'opened-set';
  if (set && Array.isArray(set)) {
    set.forEach((card, ci) => {
      if (card) setDiv.appendChild(makeCard(card, 'sm', { overlap: ci > 0 }));
    });
  }
  setDiv.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (dragStartIndex === null) return;
    if (!isMyTurn || !isOpened) return;
    const draggedCard = myHand[dragStartIndex];
    if (!draggedCard) return;
    const valid = canMeelGali(draggedCard, set);
    setDiv.classList.toggle('drop-target', valid);
    setDiv.classList.toggle('drop-invalid', !valid);
    e.dataTransfer.dropEffect = valid ? 'move' : 'none';
  });
  setDiv.addEventListener('dragleave', () => { setDiv.classList.remove('drop-target', 'drop-invalid'); });
  setDiv.addEventListener('drop', (e) => {
    e.preventDefault();
    setDiv.classList.remove('drop-target', 'drop-invalid');
    if (dragStartIndex === null) return;
    if (!isMyTurn || !isOpened) return;
    const draggedCard = myHand[dragStartIndex];
    if (!draggedCard) return;
    if (!canMeelGali(draggedCard, set)) {
      showNotification('❌ Kaartan meesha kuma fiicna!');
      setDiv.style.transition = 'transform 0.1s';
      let i = 0;
      const shake = setInterval(() => {
        setDiv.style.transform = i % 2 === 0 ? 'translateX(-5px)' : 'translateX(5px)';
        if (++i > 5) { clearInterval(shake); setDiv.style.transform = ''; }
      }, 60);
      dragStartIndex = null;
      return;
    }
    const cardIdx = dragStartIndex;
    dragStartIndex = null;
    myHand.splice(cardIdx, 1);
    myHand.forEach(c => { c.selected = false; });
    renderHand();
    if (socket) {
      socket.emit('addToExistingSets', { cards: [draggedCard] });
      socket.emit('syncHandAfterMeld', myHand);
    }
    showNotification('✅ Kaartu miiska ayay u gashay!', 1500);
  });
  return setDiv;
}

function renderMyTableSets() {
  const myContainer = $('my-table-sets');
  if (myContainer) myContainer.innerHTML = '';
  tablePlayers.forEach(player => {
    if (player.id === socket.id) {
      if (!myContainer) return;
      player.openedSets.forEach((set, setIdx) => {
        const setDiv = makeDraggableSet(set, setIdx, player.id);
        myContainer.appendChild(setDiv);
      });
    } else {
      let slotId = '';
      if (player.id === opponents.top?.id) slotId = 'sets-bot-top';
      else if (player.id === opponents.left?.id) slotId = 'sets-bot-left';
      else if (player.id === opponents.right?.id) slotId = 'sets-bot-right';
      const oppContainer = $(slotId);
      if (oppContainer) {
        oppContainer.innerHTML = '';
        player.openedSets.forEach(set => {
          const setDiv = document.createElement('div');
          setDiv.className = 'opened-set';
          set.forEach(card => {
            const el = makeCard(card, 'sm');
            el.classList.add('card-pickup-anim');
            setDiv.appendChild(el);
          });
          oppContainer.appendChild(setDiv);
        });
      }
    }
  });
}

function renderDiscardPile() {
  const el = $('discard-display');
  if (!el) return;
  el.innerHTML = '';
  if (discardTop) {
    const card = makeCard(discardTop, 'lg');
    el.className = '';
    el.appendChild(card);
  } else {
    el.className = 'discard-empty';
    el.textContent = 'Madhan';
  }
}

function renderStockPile() {
  const el = $('stock-count-label');
  if (el) el.textContent = stockCount;
}

function getPlayerScoreMarkup(playerName) {
  const data = getMergedSessionScores();
  const entry = data[normalizeName(playerName)];
  const net = entry ? (entry.wins || 0) - (entry.fooros || 0) : 0;
  const scoreClass = net > 0
    ? 'player-score'
    : net < 0
      ? 'player-score player-score-negative'
      : 'player-score player-score-zero';
  const sign = net > 0 ? '+' : '';
  return `<span class="${scoreClass}" aria-label="Dhibco ${sign}${net}">(${sign}${net})</span>`;
}

function renderOpponentSlot(position, opponentName, count, active, opened, sets, isBot, oppPlayerId) {
  const badge = $(`badge-${position}`), cardsEl = $(`cards-${position}`);
  if (!badge || !cardsEl) return;
  if (!opponentName) { badge.textContent = 'Sugaya...'; badge.className = 'player-badge'; cardsEl.innerHTML = ''; return; }
  const botIcon = isBot ? ' 🤖' : '';
  const scoreMarkup = getPlayerScoreMarkup(opponentName);
  badge.innerHTML = `${escapeHistoryHtml(opponentName)}${botIcon}${opened ? ' ✓' : ''} ${scoreMarkup}`;
  badge.className = active ? 'player-badge active' : 'player-badge';
  cardsEl.innerHTML = '';
  if (sets && sets.length > 0) {
    sets.forEach((set, setIdx) => {
      const setDiv = makeDraggableSet(set, setIdx, oppPlayerId || '');
      cardsEl.appendChild(setDiv);
    });
  } else {
    for (let i = 0; i < count; i++) cardsEl.appendChild(makeCardBack('sm'));
  }
}

function getPlayerAtOffset(offset) {
  if (!socket || !socket.id || !players || !Array.isArray(players) || players.length === 0) return null;
  const myIdx = players.findIndex(p => p && p.id === socket.id);
  if (myIdx === -1) return null;
  return players[(myIdx + offset) % players.length] || null;
}

function getTablePlayerAtOffset(offset) {
  if (!socket || !socket.id || !tablePlayers || !Array.isArray(tablePlayers) || tablePlayers.length === 0) return null;
  const myIdx = tablePlayers.findIndex(p => p && p.id === socket.id);
  if (myIdx === -1) return null;
  return tablePlayers[(myIdx + offset) % tablePlayers.length] || null;
}

function renderOpponents() {
  const offsets = { left: 3, top: 2, right: 1 };
  ['left', 'top', 'right'].forEach(pos => {
    const p = getPlayerAtOffset(offsets[pos]);
    const tp = getTablePlayerAtOffset(offsets[pos]);
    const sets = tp ? (tp.openedSets || []) : [];
    renderOpponentSlot(pos,
      p ? p.name : (opponents[pos] ? opponents[pos].name : null),
      p ? p.cardCount : 0,
      p ? p.id === currentTurnId : false,
      p ? p.isOpened : false,
      sets,
      p ? p.isBot : false,
      tp ? tp.id : (p ? p.id : '')
    );
  });
}

function renderMyBadge() {
  const badge = $('my-name-badge');
  if (!badge) return;
  badge.innerHTML = `${escapeHistoryHtml(myName)}${isOpened ? ' ✓' : ''} (Adiga) ${getPlayerScoreMarkup(myName)}`;
  const amActive = socket && currentTurnId === socket.id;
  badge.className = `my-name-badge bold ${amActive ? 'active' : 'gold'}`;
}

function renderAll() {
  renderHeader(); renderHand(); renderDiscardPile();
  renderStockPile(); renderOpponents(); renderMyBadge(); renderMyTableSets();
}

function toggleCard(idx) {
  myHand[idx] = { ...myHand[idx], selected: !myHand[idx].selected };
  renderHand();
}

function handleDrop(targetIdx) {
  if (dragStartIndex === null || dragStartIndex === targetIdx) return;
  const moved = myHand.splice(dragStartIndex, 1)[0];
  myHand.splice(targetIdx, 0, moved);
  dragStartIndex = null;
  renderHand();
}

function handleSort() {
  const vOrder = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'j': 11, 'q': 12, 'k': 13, 'a': 14, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
  const sOrder = { '♠': 4, '♥': 3, '♦': 2, '♣': 1 };
  myHand.sort((a, b) => {
    const sA = sOrder[a.suit] || 0, sB = sOrder[b.suit] || 0;
    if (a.suit !== b.suit) return sB - sA;
    return (vOrder[a.value] || 0) - (vOrder[b.value] || 0);
  });
  myHand = myHand.map(c => ({ ...c, selected: false }));
  renderHand();
}

function handleDraw() {
  if (!isMyTurn) { showNotification('Sug doorkaaga!'); return; }
  if (hasDrawn) { showNotification('Horey ayaad u qaadatay kaar.'); return; }
  const drawEl = $('btn-draw');
  if (drawEl) {
    drawEl.classList.remove('card-pickup-anim');
    void drawEl.offsetWidth;
    drawEl.classList.add('card-pickup-anim');
    drawEl.addEventListener('animationend', () => drawEl.classList.remove('card-pickup-anim'), { once: true });
  }
  if (socket) socket.emit('drawCard');
}

function handlePickDiscard() {
  if (!isMyTurn) { showNotification('Sug doorkaaga!'); return; }
  if (hasDrawn) { showNotification('Horey ayaad u qaadatay kaar.'); return; }
  if (!discardTop) { showNotification('Tuurista kuma jiraan kaar.'); return; }
  const discardEl = $('discard-display');
  if (discardEl) {
    discardEl.classList.remove('card-pickup-anim');
    void discardEl.offsetWidth;
    discardEl.classList.add('card-pickup-anim');
    discardEl.addEventListener('animationend', () => discardEl.classList.remove('card-pickup-anim'), { once: true });
  }
  if (socket) socket.emit('pickDiscard');
}

function handleDhigo() {
  if (!isMyTurn) { showNotification('Sug doorkaaga!'); return; }
  const selected = myHand.filter(c => c.selected);
  if (selected.length === 0) { showNotification('Fadlan dooro kaarka aad dhigayso!'); return; }
  if (pickedFromDiscard && !selected.some(card => card.id === lastPickedDiscardId)) {
    showNotification('❌ Kaarka tuurka aad qaadatay waa inuu ku jiraa dhigista xigta!');
    return;
  }

  if (isOpened && selected.length < 3) {
    const serverSets = tablePlayers.flatMap(p => p.openedSets || []);
    let currentTableSets = serverSets.length > 0 ? serverSets : [...myOpenedSets];
    let validAdditions = [], invalidCards = [];
    selected.forEach(card => {
      let fitsInAnySet = false;
      currentTableSets.forEach(set => {
        if (!set || set.length < 3) return;
        if (canMeelGali(card, set)) fitsInAnySet = true;
      });
      if (fitsInAnySet) validAdditions.push(card);
      else invalidCards.push(card);
    });
    if (pickedFromDiscard && !validAdditions.some(card => card.id === lastPickedDiscardId)) {
      showNotification('❌ Kaarka tuurka aad qaadatay kuma dari kartid kooxahan; dooro koox uu ku habboon yahay!');
      return;
    }
    if (validAdditions.length > 0) {
      const selectedIds = new Set(validAdditions.map(c => c.id));
      myHand = myHand.filter(c => !selectedIds.has(c.id)).map(c => ({ ...c, selected: false }));
      if (socket) {
        socket.emit('addToExistingSets', { cards: validAdditions });
        socket.emit('syncHandAfterMeld', myHand);
      }
      if (invalidCards.length > 0) showNotification(`Waxaad ku darsatay ${validAdditions.length} kaar, laakiin kaarka ${invalidCards[0].value}${invalidCards[0].suit} ma geli karo miiska!`);
      else showNotification(`Waad ku darsatay miiska ${validAdditions.length} kaar!`);
      renderAll();
      return;
    } else if (invalidCards.length > 0) {
      showNotification(`Kaarka xulan (${invalidCards[0].value}${invalidCards[0].suit}) kuma darsami karo kooxaha miiska saaran!`);
      return;
    }
  }

  if (selected.length < 3) { showNotification('Dooro ugu yaraan 3 kaar oo koox ah si aad u dhigato!'); return; }

  const { validGroups, remaining } = findValidGroups(selected);
  if (remaining.length > 0) { showNotification(`Kaarka ${remaining[0].value}${remaining[0].suit} ma geli karo koox!`); return; }

  const processedGroups = [];
  validGroups.forEach(group => {
    if (group.length === 6) { processedGroups.push(group.slice(0, 3), group.slice(3, 6)); }
    else if (group.length === 7) { processedGroups.push(group.slice(0, 4), group.slice(4, 7)); }
    else { processedGroups.push(group); }
  });

  const moveScore = selected.reduce((s, c) => s + cardPoints(c), 0);

  if (!isOpened) {
    const currentTotal = temporaryScore + moveScore;
    const allSetsSoFar = [...myOpenedSets, ...processedGroups];
    const hasFourPlus = allSetsSoFar.some(g => g.length >= 4);
    const effectiveMin = currentMinToOpen;

    // Hubi haddii uu ciyaaryahanku gacanta ka saarayo dhammaan kaararkiisa hal mar (Finishing Move)
    const isFinishingMove = selected.length === myHand.length;

    // Haddii uu yahay Finishing Move, XAKUNKA DHIBCAHA LA CQSAYO WAA LA DHAARIYAA (Skipped)
    if (isFinishingMove) {
      isOpened = true; iHaveOpened = true;
      myOpenedSets = allSetsSoFar;
      myHand = [];
      if (socket) {
        socket.emit('meldSets', { sets: allSetsSoFar, totalScore: currentTotal, isAdditional: false });
        socket.emit('syncHandAfterMeld', myHand);
        // Halkan waxaa la waci karaa ama la diri karaa dhacdada xiritaanka ciyaarta (endGame)
      }
      showNotification(`🎉 Hambalyo! Waxaad si guul leh ku wada xirtay gacantaada!`);
      renderAll();
      return;
    }

    if (pickedFromDiscard && currentTotal < effectiveMin) {
      showNotification(`❌ Kaarka tuurka aad qaadatay waa inaad ku furataa ugu yaraan ${effectiveMin} dhibco.`);
      return;
    }

    if (currentTotal >= effectiveMin && hasFourPlus) {
      isOpened = true; iHaveOpened = true; myOpeningScore = currentTotal;
      myOpenedSets = allSetsSoFar;
      const selectedIds = new Set(selected.map(c => c.id));
      myHand = myHand.filter(c => !selectedIds.has(c.id)).map(c => ({ ...c, selected: false }));
      if (socket) {
        socket.emit('meldSets', { sets: allSetsSoFar, totalScore: currentTotal, isAdditional: false });
        socket.emit('syncHandAfterMeld', myHand);
      }
      temporaryScore = 0;
      showNotification(`Waad degtay! ${currentTotal} dhibco.`);
    } else {
      if (!hasFourPlus) { showNotification('Waxaad u baahan tahay ugu yaraan hal koox oo 4+ kaar ah!'); return; }
      if (currentTotal < effectiveMin) { showNotification(`Ma degi kartid! U baahan: ${effectiveMin} dhibco.`); return; }
      temporaryScore += moveScore;
      myOpenedSets = [...myOpenedSets, ...processedGroups];
      const selectedIds = new Set(selected.map(c => c.id));
      myHand = myHand.filter(c => !selectedIds.has(c.id)).map(c => ({ ...c, selected: false }));
      if (socket) socket.emit('syncHandAfterMeld', myHand);
      showNotification(`Wadarta: ${temporaryScore}. U baahan: ${effectiveMin}`);
    }
  } else {
    const selectedIds = new Set(selected.map(c => c.id));
    myHand = myHand.filter(c => !selectedIds.has(c.id)).map(c => ({ ...c, selected: false }));
    if (socket) {
      socket.emit('meldSets', { sets: processedGroups, isAdditional: true });
      socket.emit('syncHandAfterMeld', myHand);
    }
    myOpenedSets = [...myOpenedSets, ...processedGroups];
  }
  renderAll();
}

function handleReset() {
  if (iHaveOpened || isOpened) { showNotification('Hore ayaad u degtay, kama noqon kartid!'); return; }
  if (!myOpenedSets.length) { showNotification('Ma jiraan kaarar aad dhigtay.'); return; }
  const back = myOpenedSets.flat().map(c => ({ ...c, selected: false }));
  myHand = [...myHand, ...back];
  myOpenedSets = []; temporaryScore = 0;
  if (socket) socket.emit('resetMyOpenedCards');
  showNotification('Kaararkii waa lagu soo celiyay gacantaada.');
  renderAll();
}

function handleTuur() {
  if (!isMyTurn) { 
    showNotification('Sug doorkaaga!'); 
    return; 
  }
  
  const canSkipDraw = myHand.length >= 15 || (isOpened && myHand.length === 1);
  if (!hasDrawn && !canSkipDraw) { 
    showNotification('Fadlan marka hore kaar qaado ama tuurista ka qaado!'); 
    return; 
  }

  // Xalka cusub: Hubinta iyo iskudayga in kaarka si toos ah loo galiyo miiska haddii uu suurtagal yahay
  if (pickedFromDiscard) {
    if (isOpened && lastPickedDiscardId) {
      const pickedCard = myHand.find(c => c.id === lastPickedDiscardId);
      if (pickedCard) {
        // Halkan geli baaritaankaaga meel-gelinta (tusaale: canMeelGali ama logic-gaaga miiska)
        const isMeelGale = typeof checkCardCanBeMeld === 'function' ? checkCardCanBeMeld(pickedCard) : true; // Beddel magaca halkaan haddii uu ka duwan yahay

        if (isMeelGale) {
          // Si toos ah ugu dar miiska
          if (socket) {
            socket.emit('addToExistingSets', { cards: [pickedCard] });
            socket.emit('syncHandAfterMeld', myHand);
          }
          
          // Ka saar gacanta kaarkii la isticmaalay
          const pIdx = myHand.findIndex(c => c.id === lastPickedDiscardId);
          if (pIdx !== -1) myHand.splice(pIdx, 1);

          pickedFromDiscard = false;
          lastPickedDiscardId = null;
          // Halkaan ayay si toos ah uga gudubtaa (fall through) oo ay ugu dhaqaaqaysaa tuurista caadiga ah
        } else {
          showNotification('Tuurista ayaad qaadatay — fadlan marka hore "Dhigo" riix oo ku dar kaarka!');
          return;
        }
      } else {
        pickedFromDiscard = false;
        lastPickedDiscardId = null;
      }
    } else {
      showNotification(isOpened
        ? 'Tuurista ayaad qaadatay — marka hore ku dar kaarka miiska saaran!'
        : "Tuurista ayaad qaadatay — marka hore 'Dhigo' riix oo ku dar kaarka!");
      return;
    }
  }

  const selIdx = myHand.findIndex(c => c.selected);
  if (selIdx === -1) { 
    showNotification('Dooro kaarka aad tuurayso!'); 
    return; 
  }

  const cardToPlay = myHand[selIdx];

  if (cardToPlay.fromDiscard) {
    showNotification('Ma tuuri kartid kaarka aad tuurista ka qaadatay ilaa aad miiska ku darto!');
    return;
  }

  const discardEl = $('discard-display');
  if (discardEl) {
    discardEl.classList.remove('card-throw-anim');
    void discardEl.offsetWidth;
    discardEl.classList.add('card-throw-anim');
    discardEl.addEventListener('animationend', () => discardEl.classList.remove('card-throw-anim'), { once: true });
  }

  if (socket) socket.emit('playCard', { card: cardToPlay });
  
  myHand.splice(selIdx, 1);
  isMyTurn = false; 
  hasDrawn = false; 
  pickedFromDiscard = false; 
  lastPickedDiscardId = null;
  
  clearInterval(turnTimerInterval);
  myHand.forEach(c => { c.selected = false; c.fromDiscard = false; });
  renderAll();
}

function startWaitingCountdown() {
  waitingCountdown = 240;
  const noteEl = $('waiting-auto-note');
  if (noteEl) noteEl.textContent = `Haddaan la helin qof: robots ${waitingCountdown}s`;
  if (waitingAutoTimer) clearInterval(waitingAutoTimer);
  waitingAutoTimer = setInterval(() => {
    waitingCountdown--;
    if (noteEl) noteEl.textContent = `Haddaan la helin qof: robots ${waitingCountdown}s`;
    if (waitingCountdown <= 0) { clearInterval(waitingAutoTimer); waitingAutoTimer = null; if (noteEl) noteEl.textContent = 'Robotyada la keenayaa...'; }
  }, 1000);
}

function stopWaitingCountdown() {
  if (waitingAutoTimer) { clearInterval(waitingAutoTimer); waitingAutoTimer = null; }
  const noteEl = $('waiting-auto-note');
  if (noteEl) noteEl.textContent = '';
}

function renderWaitingRoom(plist) {
  const countEl = $('waiting-count');
  if (countEl) countEl.textContent = `Raadinaya... (${plist.length}/4)`;
  const list = $('waiting-list');
  if (!list) return;
  list.innerHTML = '';
  plist.forEach(p => {
    const row = document.createElement('div');
    row.className = p.isBot ? 'waiting-player waiting-bot' : 'waiting-player';
    row.innerHTML = p.isBot
      ? `<span class="dot">🤖</span><span class="pname">${p.name}</span><span class="ready bot-label">Robot</span>`
      : `<span class="dot">●</span><span class="pname">${p.name}</span><span class="ready">Diyaar</span>`;
    list.appendChild(row);
  });
  for (let i = plist.length; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'waiting-empty';
    row.innerHTML = `<span style="animation:pulse 1s infinite;color:#555">●</span><span>Sugaya...</span>`;
    list.appendChild(row);
  }
  const humanCount = plist.filter(p => !p.isBot).length;
  if (humanCount >= 2 || plist.length >= 4) { stopWaitingCountdown(); const noteEl = $('waiting-auto-note'); if (noteEl) noteEl.textContent = ''; }
}

function joinGame() {
  const nameInput = $('name-input');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) { showNotification('Fadlan geli magacaaga!'); return; }
  myName = name;
  inGame = false;
  players = [];
  sessionStorage.removeItem(SESSION_KEY);
  const xiiliSel = $('xiili-select');
  if (xiiliSel) xiiliTarget = parseInt(xiiliSel.value) || 5;
  showScreen('waiting');
  renderWaitingRoom([]);
  // Send xiiliTarget to server so it can track it per room
  const payload = myProfileName
    ? { name, profileName: myProfileName, xiiliTarget }
    : { name, xiiliTarget };
  if (socket) socket.emit('joinRandom', payload);
  startWaitingCountdown();
  setTimeout(() => { typeWriter('waiting-typewriter', `${name}, soo dhowoow! Dulqaado fadlan inta ay ciyaartooyda kale ku soo biirayaan...`, 48); }, 300);
}

// ─── Auth Functions ────────────────────────────────────────────────────────────
async function authPost(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { ok: false, error: `Server-ka ${url} kama helin (${res.status}).` }; }
  } catch (e) {
    return { ok: false, error: `Xiriirka server-ka waa la jartay (${e.message || 'network error'})` };
  }
}

async function authRegister(name, pin) { return authPost('/api/auth/register', { name, pin }); }
async function authLogin(name, pin) { return authPost('/api/auth/login', { name, pin }); }

function setLoggedIn(profile) {
  myProfileName = profile.name;
  myProfileData = profile;
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) {}
  const nameInput = $('name-input');
  if (nameInput) nameInput.value = profile.name;
  renderAuthStatus();
}

function setLoggedOut() {
  myProfileName = null;
  myProfileData = null;
  try { localStorage.removeItem(PROFILE_KEY); } catch (e) {}
  renderAuthStatus();
}

function restoreSavedProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return;
    const profile = JSON.parse(raw);
    if (!profile || !profile.name) return;
    myProfileName = profile.name;
    myProfileData = profile;
    const nameInput = $('name-input');
    if (nameInput) nameInput.value = profile.name;
  } catch (e) {}
}

function renderAuthStatus() {
  const statusEl = $('auth-status');
  const loginArea = $('auth-login-area');
  if (!statusEl || !loginArea) return;

  if (myProfileData) {
    const sign = myProfileData.score >= 0 ? '+' : '';
    statusEl.innerHTML = `
      <div class="auth-logged-in">
        <span class="auth-name">👤 ${myProfileData.name}</span>
        <span class="auth-score">${sign}${myProfileData.score} dhibco</span>
        <span class="auth-stats">(${myProfileData.wins}G · ${myProfileData.fooros}F · ${myProfileData.games} ciyaar)</span>
        <button class="btn-auth-small btn-auth-logout" onclick="setLoggedOut()">Ka bax</button>
      </div>`;
    loginArea.classList.add('hidden');
  } else {
    statusEl.innerHTML = `<span class="auth-guest">🎮 Martida (Guest) — Dhibacyada lama xifidayo</span>`;
    loginArea.classList.remove('hidden');
  }
}

async function handleAuthSubmit(mode) {
  const nameInput = $('auth-name-input');
  const pinInput = $('auth-pin-input');
  const errEl = $('auth-error');
  const name = nameInput ? nameInput.value.trim() : '';
  const pin = pinInput ? pinInput.value.trim() : '';

  if (!name) { 
    if (errEl) errEl.textContent = 'Magacaaga geli'; 
    return; 
  }
  if (!/^\d{4}$/.test(pin)) { 
    if (errEl) errEl.textContent = 'PIN waa inuu ahaadaa 4 lambar'; 
    return; 
  }
  if (errEl) errEl.textContent = 'Sugaya...';

  const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const result = await authPost(endpoint, { name, pin });

  if (result.ok) {
    setLoggedIn(result.profile);
    if (errEl) errEl.textContent = '';
    showNotification(mode === 'register' ? `✅ Xisabta la furey! Soo dhowow ${result.profile.name}` : `✅ Soo galootay! ${result.profile.name}`, 4000);
  } else {
    if (errEl) errEl.textContent = result.error || 'Khalad ayaa dhacay';
  }
}

function toggleAuthMode() {
  const loginBtn = $('btn-auth-login');
  const registerBtn = $('btn-auth-register');
  const modeLabel = $('auth-mode-label');
  const toggleLink = $('auth-toggle-link');
  const errEl = $('auth-error');
  if (!loginBtn || !registerBtn) return;

  const isLoginMode = loginBtn.style.display !== 'none';
  if (isLoginMode) {
    loginBtn.style.display = 'none';
    registerBtn.style.display = 'inline-block';
    if (modeLabel) modeLabel.textContent = 'Diiwaan Cusub';
    if (toggleLink) toggleLink.textContent = 'Xisab hore u leedahay? Gal';
  } else {
    loginBtn.style.display = 'inline-block';
    registerBtn.style.display = 'none';
    if (modeLabel) modeLabel.textContent = 'Gal';
    if (toggleLink) toggleLink.textContent = 'Xisab cusub? Diiwaangeli';
  }
  if (errEl) errEl.textContent = '';
}

function renderLeaderboard(data) {
  // Haddii uusan array jirin ama uu madhan yahay, isku day in aad ka soo akhriso merged session scores-ka si uusan u madhnaan
  let boardData = data;
  if (!boardData || !boardData.length) {
    const merged = getMergedSessionScores();
    boardData = Object.entries(merged).map(([key, d]) => ({
      name: d.displayName || key,
      wins: d.wins || 0,
      fooros: d.fooros || 0,
      games: d.games || 0,
      score: (d.wins || 0) - (d.fooros || 0)
    }));
    // Kala saar oo sifee dhibcaha (net-ka)
    boardData.sort((a, b) => b.score - a.score);
  }

  if (!boardData.length) return '<p style="color:#888;text-align:center;font-size:0.85em">Wali ciyaar la gaadhay ma jirto</p>';

  const rows = boardData.slice(0, 10).map((p, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
    const scoreVal = typeof p.score === 'number' ? p.score : ((p.wins || 0) - (p.fooros || 0));
    const sign = scoreVal >= 0 ? '+' : '';
    const scoreColor = scoreVal > 0 ? '#2ecc71' : scoreVal < 0 ? '#e74c3c' : '#aaa';
    
    const pName = p.name || '';
    const isMe = (myName && pName.toLowerCase() === myName.toLowerCase()) || 
                 (myProfileName && pName.toLowerCase() === myProfileName.toLowerCase());
                 
    const highlight = isMe ? 'background:rgba(255,215,0,0.08);border-left:2px solid #f1c40f;' : '';
    
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.06);${highlight}">
      <span style="width:22px;text-align:center;font-size:0.85em">${medal}</span>
      <span style="flex:1;font-weight:${isMe?700:400}">${pName}${isMe?' (Adiga)':''}</span>
      <span style="color:${scoreColor};font-weight:700;min-width:36px;text-align:right">${sign}${scoreVal}</span>
      <span style="color:#888;font-size:0.75em;min-width:60px;text-align:right">${p.wins || 0}G·${p.fooros || 0}F·${p.games || 0}C</span>
    </div>`;
  }).join('');

  return `<div style="font-size:0.82em;color:#ccc">${rows}</div>`;
}


function updateFooroPanel() {
  const panel = $('fooro-list');
  renderOpponents();
  renderMyBadge();
  if (!panel) {
    updateHeaderScore();
    return;
  }

  const data = getMergedSessionScores();
  const entries = Object.entries(data);
  const currentXiiliTarget = typeof xiiliTarget !== 'undefined' ? xiiliTarget : (typeof xiroTarget !== 'undefined' ? xiroTarget : 5);

  const targetLabel = $('fooro-target-label');
  if (targetLabel) {
    targetLabel.textContent = `${currentXiiliTarget} Fooro`;
  }

  if (!entries.length) {
    const pairNotice = sessionDabaaqPairs.length
      ? `<div class="dabaaq-notice">DABAAQ: ${sessionDabaaqPairs.map(pair => `${pair.player1} + ${pair.player2}`).join(' · ')}</div>`
      : '';
    panel.innerHTML = pairNotice + '<div class="fooro-empty">Weli ciyaar la gaadhay ma jirto</div>';
    return;
  }

  entries.sort((a, b) => {
    const netA = (a[1].wins || 0) - (a[1].fooros || 0);
    const netB = (b[1].wins || 0) - (b[1].fooros || 0);
    return netA - netB;
  });

  const pairNotice = sessionDabaaqPairs.length
    ? `<div class="dabaaq-notice"><b>DABAAQ U TAAL:</b> ${sessionDabaaqPairs.map(pair => {
        const amount = Math.max(1, Number(pair.amount) || 1);
        const isNegative = pair.type === 'negative_negative';
        return `${pair.player1} iyo ${pair.player2}${isNegative ? ` (${amount} vs ${amount})` : ''}`;
      }).join(' · ')}<small> — dhibcaha ugu yar ayaa la isla dhigtaa; kii hore xira ayaa xeerka qaata</small></div>`
    : '';

  const ownershipLinks = entries.flatMap(([key, d]) => {
    const victim = d.displayName || d.name || key;
    const victimKey = normalizeName(victim);
    const seenOwners = new Set();
    return (Array.isArray(d.fooroOwners) ? d.fooroOwners : [])
      .filter(Boolean)
      .filter(owner => {
        const ownerKey = normalizeName(owner);
        if (!ownerKey || ownerKey === victimKey || seenOwners.has(ownerKey)) return false;
        seenOwners.add(ownerKey);
        return true;
      })
      .map(owner =>
        `${escapeHistoryHtml(owner)} → ${escapeHistoryHtml(victim)}`
      );
  });
  const ownershipNotice = ownershipLinks.length
    ? `<div class="fooro-ownership-notice"><b>FOORO:</b> ${ownershipLinks.join(' · ')}</div>`
    : '';

  panel.innerHTML = pairNotice + ownershipNotice + entries.map(([key, d]) => {
    const wins = d.wins || 0;
    const fooros = d.fooros || 0;
    const net = wins - fooros;
    const displayName = d.displayName || d.name || key;

    /*
     * Goobooyinku waxay matalayaan score-ka net-ka, ma aha wins iyo fooros
     * la isku dul sawiray. Haddii 2 Fooro ay la kulmaan 1 Guul, natiijadu
     * waa -1 oo hal goobo cas oo keliya ayaa muuqanaysa.
     */
    const activeFooros = Math.max(0, fooros - wins);
    const activeWins = Math.max(0, wins - fooros);

    const meKeys = new Set();
    if (myName) meKeys.add(normalizeName(myName));
    if (myProfileName) meKeys.add(normalizeName(myProfileName));
    const isMe = meKeys.has(normalizeName(key));

    let scoreClass, scoreText;
    if (net > 0) { scoreClass = 'fooro-score-pos'; scoreText = `+${net}`; }
    else if (net < 0) { scoreClass = 'fooro-score-neg'; scoreText = `${net}`; }
    else { scoreClass = 'fooro-score-zero'; scoreText = '0'; }

    /*
     * Dhibcaha cad ma aha fooro jira; waxay ahaayeen boosaska
     * target-ka (5) ee bannaan. In la sawiro waxay u ekaysiinaysay
     * in ciyaaryahanku leeyahay 5 fooro. Hadda waxaa la muujinayaa
     * oo keliya tirada dhabta ah ee firfircoon.
     */
    const dots = [];
    if (activeFooros > 0) {
      for (let i = 0; i < Math.min(activeFooros, currentXiiliTarget); i++) {
        dots.push('🔴');
      }
    }
    if (activeWins > 0) {
      for (let i = 0; i < Math.min(activeWins, currentXiiliTarget); i++) {
        dots.push('🟢');
      }
    }

    return `<div class="fooro-row${isMe ? ' fooro-me' : ''}">
      <span class="fooro-name">${displayName}${isMe ? ' ★' : ''}</span>
      <span class="fooro-score ${scoreClass}">${scoreText}</span>
      <span class="fooro-dots">${dots.join('')}</span>
    </div>`;
  }).join('');

  // ── HALKAN AYAA LAGU KICIYAA SI UU HEADER-KU JOOGTO U AHAADO ──
  updateHeaderScore();
}

function updateHeaderScore() {
  const hdrScoreEl = document.getElementById('hdr-score');
  if (!hdrScoreEl) return;

  const data = getMergedSessionScores();
  if (!data) return;

  // Hel ciyaaryahanka hadda jooga
  const entries = Object.entries(data);
  const meKeys = new Set();
  if (typeof myName !== 'undefined' && myName) meKeys.add(normalizeName(myName));
  if (typeof myProfileName !== 'undefined' && myProfileName) meKeys.add(normalizeName(myProfileName));

  let myScoreData = null;
  for (const [key, d] of entries) {
    if (meKeys.has(normalizeName(key))) {
      myScoreData = d;
      break;
    }
  }

  if (myScoreData) {
    const wins = myScoreData.wins || 0;
    const fooros = myScoreData.fooros || 0;
    const net = wins - fooros;

    let scoreClass, scoreText;
if (net > 0) { 
  scoreClass = 'fooro-score-pos'; 
  scoreText = `Dhibco: +${net}`; 
}
else if (net < 0) { 
  scoreClass = 'fooro-score-neg'; 
  scoreText = `Dhibco: ${net}`; 
}
else { 
  scoreClass = 'fooro-score-zero'; 
  scoreText = 'Dhibco: 0'; 
}
    hdrScoreEl.textContent = scoreText;
    hdrScoreEl.className = `bold header-score-value ${scoreClass}`;
  } else {
    hdrScoreEl.textContent = "0";
    hdrScoreEl.className = `bold header-score-value fooro-score-zero`;
  }
}

function checkSeasonEnd() {
  const mergedScores = getMergedSessionScores();
  const loser = Object.entries(mergedScores).find(([, d]) => d.fooros >= xiiliTarget);
  if (!loser) return;
  const modal = $('season-modal');
  if (!modal || !modal.classList.contains('hidden')) return;
  
  // 1. Marka hore soo saar jadwalka adigoo isticmaalaya mergedScores-kii la hayay
  const body = $('season-modal-body');
  if (body) body.textContent = `${loser[1].displayName || loser[0]} wuxuu gaaray xadkii ${xiiliTarget} fooro — Xilli-ciyaareedkii wuu dhammaaday!`;
  
  const scoresEl = $('season-final-scores');
  if (scoresEl) {
    const sorted = Object.entries(mergedScores).sort((a, b) => a[1].fooros - b[1].fooros || b[1].wins - a[1].wins);
    scoresEl.innerHTML = sorted.map(([key, d]) => {
      const isL = key === loser[0];
      const net = (d.wins || 0) - (d.fooros || 0);
      const scoreClass = net > 0 ? 'fooro-score-pos' : net < 0 ? 'fooro-score-neg' : 'fooro-score-zero';
      const scoreText = net > 0 ? `+${net}` : net < 0 ? `${net}` : '0';
      return `<div class="fooro-row${isL ? ' fooro-loser' : ''}">
        <span class="fooro-name">${d.displayName || key}</span>
        <span class="fooro-wins">🟢 ${d.wins}</span>
        <span class="fooro-score ${scoreClass}">${scoreText}${isL?' ❌':''}</span>
      </div>`;
    }).join('');
  }

  // 2. Hadda muuji modal-ka
  modal.classList.remove('hidden');

  // 3. Markaad hubiso in jadwalkii la dhisay, halkaan ku dhufo tirtiridda (ama uga tag sidaada haddii resetProfileScoresOnSeasonEnd aysan isla markaana tirtiraynin variable-ka aan kor ku isticmaalnay ee mergedScores)
  resetProfileScoresOnSeasonEnd();
}

// Server-ku wuxuu si toos ah u reset-gareeyaa profiles-ka marka xilligu dhammaado.
function resetProfileScoresOnSeasonEnd() {
  // Server-ku wuxuu reset-gareeyaa dhammaan profiles-ka marka xilligu dhammaado.
  // Browser-ka sidoo kale ka nadiifi xogta hore si 1G/3F/12 ciyaar aysan uga
  // muuqan profile-ka ilaa xog cusub la bilaabo.
  if (myProfileData) {
    myProfileData = { ...myProfileData, score: 0, wins: 0, fooros: 0, games: 0 };
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(myProfileData)); } catch (e) {}
    renderAuthStatus();
  }
}

function startNewSeason() {
  if (socket && socket.connected) socket.emit('startNewSeason');
  sessionFooros = {};
  serverSessionScores = {};
  clearSessionScores();
  updateFooroPanel();
  const modal = $('season-modal');
  if (modal) modal.classList.add('hidden');
  exitGame();
}

function startNextGame() {
  const modal = $('gameover-modal');
  if (modal) modal.classList.add('hidden');

  // Ciyaar cusub ha ku bilaaban leaveGame + reload: taas waxay ka
  // saari jirtay ciyaaryahanka qolka oo mararka qaar waxay jabin jirtay
  // socket-ka ciyaarta labaad.
  isMyTurn = false;
  hasDrawn = false;
  pickedFromDiscard = false;
  lastPickedDiscardId = null;
  if (turnTimerInterval) clearInterval(turnTimerInterval);

  if (socket && socket.connected) {
    socket.emit('forceResetGame');
  } else {
    // Haddii xiriirku go'an yahay, habka hore ee reconnect-ka ha shaqeeyo.
    exitGame();
  }
}

function typeWriter(elementId, text, speed = 45) {
  const el = $(elementId);
  if (!el) return;
  el.textContent = '';
  let i = 0;
  function type() { if (i < text.length) { el.textContent += text.charAt(i); i++; setTimeout(type, speed); } }
  type();
}

function showReconnectOverlay(msg) {
  const overlay = $('reconnect-overlay'), msgEl = $('reconnect-msg');
  if (overlay) overlay.classList.remove('hidden');
  if (msgEl) msgEl.textContent = msg || 'Dib u xidh...';
}

function hideReconnectOverlay() {
  const overlay = $('reconnect-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function somaliGameText(isMe) {
  return {
    winner: isMe ? "Waad guuleysatay" : "Wuu guuleystay",
    loser: isMe ? "Waad guuldarraysatay" : "Wuu guuldarraystay",
    opened: isMe ? "Marka hore waad degtay" : "Marka hore wuu degay",
    notOpened: isMe ? "Ma aadan degin" : "Ma uusan degin",
    congratulations: isMe ? "Hambalyo" : "",
    closeFromHand: isMe ? "Waxaad ka xiratay gacanta" : "Wuxuu ka xiray gacanta",
    closeFromStock: isMe ? "Waxaad kor ka xiratay ciyaarta" : "Wuxuu kor ka xiray ciyaarta",
    closeGame: isMe ? "Waxaad soo gabagabaysay ciyaarta" : "Wuxuu soo gabagabeeyay ciyaarta",
    fooro: "Foorada waxay ku dhacday",
    name(isMeFlag, name) { return isMeFlag ? `Adiga (${name})` : name; }
  };
}

function buildFinishText(t, isMeWinner, winnerName, providerPlayer) {
  if (!providerPlayer) {
    return isMeWinner ? t.closeFromStock : `${winnerName} baa kor ka xiray ciyaarta.`;
  }
  return isMeWinner
    ? `${t.closeFromHand} ${providerPlayer.name}.`
    : `${winnerName} baa ka xiray gacanta ${providerPlayer.name}.`;
}

let serverOfflineTimer = null;
const SERVER_OFFLINE_GRACE_MS = 15000;

function wipeAllSessionMemory(reason) {
  try {
    sessionFooros = {};
    serverSessionScores = {};
    clearSessionScores();
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    try { localStorage.removeItem(PROFILE_KEY); } catch (e) {}
    updateFooroPanel();
    if (reason) console.warn('[t101] Xasuustii waa la tirtiray:', reason);
  } catch (e) { console.error(e); }
}

function scheduleServerOfflineWipe() {
  if (serverOfflineTimer) return;
  serverOfflineTimer = setTimeout(() => {
    serverOfflineTimer = null;
    wipeAllSessionMemory('server offline > ' + SERVER_OFFLINE_GRACE_MS + 'ms');
  }, SERVER_OFFLINE_GRACE_MS);
}

function cancelServerOfflineWipe() {
  if (serverOfflineTimer) { clearTimeout(serverOfflineTimer); serverOfflineTimer = null; }
}

function initSocket() {
  socket = io({ path: '/game-io', transports: ['polling', 'websocket'] });

  socket.on('disconnect', () => {
    showReconnectOverlay("Xiriirka waa go'ay — Dib u xidh...");
    scheduleServerOfflineWipe();
  });
  socket.on('connect', () => {
    hideReconnectOverlay();
    cancelServerOfflineWipe();
    if (inGame && myName) {
      const storedToken = sessionStorage.getItem(SESSION_KEY);
      if (storedToken && socket) {
        const reconnPayload = myProfileName
          ? { name: myName, profileName: myProfileName, xiiliTarget, token: storedToken }
          : { name: myName, xiiliTarget, token: storedToken };
        socket.emit('joinRandom', reconnPayload);
      }
    }
  });
  
  // Tusaale sida aad ugu dhex isticmaali lahayd GameOver-kaaga:
function handleGameOverData(resultsFromBackendOrLogic) {
  // resultsFromBackendOrLogic waa halka ay ka timaado xogta cida guuleysatay ama fooraysatay
  
  resultsFromBackendOrLogic.forEach(player => {
    const key = normalizeName(player.name);
    
    // Ka soo qaado xogtooda hore miiska (sessionFooros ama serverSessionScores)
    const existing = sessionFooros[key] || { wins: 0, fooros: 0 };
    
    // Wac shaqada cusub si aad u Xisaabisid dhibcaha saxda ah ee cusub
    const updated = calculatePlayerGameOverScore(key, existing.wins, existing.fooros, player.resultType);
    
    // Keydi xogta cusub
    sessionFooros[key] = {
      wins: updated.wins,
      fooros: updated.fooros,
      displayName: player.name
    };
  });

  // Keydi oo cusbooneysii panel-ka si ay isla daqiiqaddaas u soo baxaan dhibcaha saxda ah (+1, -2, iwm)
  saveSessionScores();
  updateFooroPanel();
}

  socket.on('connect_error', () => {
    showReconnectOverlay('Serverka lama gaari karo — Sugaya...');
    scheduleServerOfflineWipe();
  });
  socket.on('sessionToken', token => { if (token) sessionStorage.setItem(SESSION_KEY, token); });

  socket.on('waitingRoomUpdate', data => {
    const waitingPlayers = Array.isArray(data?.players) ? data.players : [];
    players = waitingPlayers
      .filter(Boolean)
      .map((player, index) => typeof player === 'string'
        ? { id: `waiting-${index}`, name: player }
        : player);
    renderWaitingRoom(waitingPlayers);
    updateFooroPanel();
  });

  socket.on('startHand', hand => {
    stopWaitingCountdown();
    inGame = true;
    isMyTurn = false;
    currentTurnId = null;
    myHand = hand.map(c => ({ ...c, selected: false, fromDiscard: false }));
    lastPickedDiscardId = null;
    hasDrawn = false; pickedFromDiscard = false;
    isOpened = false; iHaveOpened = false; myOpenedSets = [];
    const gameOverModal = $('gameover-modal');
    if (gameOverModal) gameOverModal.classList.add('hidden');
    showScreen('game');
    renderHeader(); renderDiscardPile(); renderStockPile(); renderMyBadge(); renderMyTableSets();
    ['left', 'top', 'right'].forEach(pos => { const c = $(`cards-${pos}`); if (c) c.innerHTML = ''; });
    const opponentCounts = { left: 14, top: 14, right: 14 };
    setTimeout(() => distributeAllCardsAnimated(myHand, opponentCounts, () => renderOpponents()), 150);
  });

  socket.on('matchFound', data => {
    stopWaitingCountdown();
    discardTop = data.topDiscard; currentTurnId = data.currentTurn;
    isMyTurn = socket && data.currentTurn === socket.id;
    showScreen('game'); renderAll();
  });

  socket.on('playersUpdate', data => {
    if (!data) return;
    const baddaCardIds = new Set(myHand.filter(c => c.fromDiscard).map(c => c.id));
    players = data.players || [];
    stockCount = data.stockCount;
    currentTurnId = data.currentTurnId;
    const wasMyTurn = isMyTurn;
    isMyTurn = socket && data.currentTurnId === socket.id;
    if (isMyTurn && !wasMyTurn) { startTurnTimer(); showNotification('Kor ka qaado ama tuurista', 2500); }
    if (data.nextRequiredPoints !== undefined) currentMinToOpen = data.nextRequiredPoints;
    if (data.barrierHistory && data.barrierHistory.length > 0) barrierHistory = data.barrierHistory;
    if (socket) {
      const me = players.find(p => p && p.id === socket.id);
      if (me) {
        myScore = me.points || 0;
        isOpened = me.isOpened;
        if (me.hand) {
          myHand = me.hand.map(c => ({
            ...c, selected: false,
            fromDiscard: baddaCardIds.has(c.id) || c.id === lastPickedDiscardId
          }));
        }
      }
    }
    updateFooroPanel();
    renderAll();
  });

  socket.on('updateTableUI', data => {
    if (!data) return;
    tablePlayers = data.players || [];
    renderMyTableSets(); renderOpponents();
  });

  socket.on('yourTurn', () => { isMyTurn = true; startTurnTimer(); showNotification('DOORKAAGA!', 2000); renderAll(); });
  socket.on('updateDiscardPile', card => { discardTop = card; renderDiscardPile(); });
  socket.on('updateStockCount', count => { stockCount = count; renderStockPile(); });

  socket.on('receiveCard', card => {
    myHand.push({ ...card, selected: false, fromDiscard: false });
    hasDrawn = true;
    renderHand();
  });

  socket.on('discardPickedSuccess', (data) => {
    hasDrawn = true; pickedFromDiscard = true; lastPickedDiscardId = data.card.id;
    showNotification('Kaarka tuurista ayaad qaadatay — Hadda waa inaad degtaa ama soo celisaa!', 3000);
    renderHeader();
  });

  socket.on('updateHand', data => {
    if (data && data.hand) {
      const baddaCardIds = new Set(myHand.filter(c => c.fromDiscard).map(c => c.id));
      const freshHand = data.hand.map(newCard => {
        const oldCard = myHand.find(c => c.id === newCard.id);
        const isSelected = oldCard ? oldCard.selected : false;
        const isFromDiscard = baddaCardIds.has(newCard.id) || newCard.id === lastPickedDiscardId;
        return { ...newCard, selected: isSelected, fromDiscard: isFromDiscard };
      });
      myHand.length = 0;
      myHand.push(...freshHand);
    }
    renderHand();
  });

  socket.on('meldRejected', data => {
    if (data && Array.isArray(data.hand)) {
      myHand = data.hand.map(card => ({
        ...card,
        selected: false,
        fromDiscard: card.id === lastPickedDiscardId,
      }));
    }
    renderAll();
  });

  socket.on('discardReturnedSuccess', () => {
    myHand.forEach(c => { c.fromDiscard = false; });
    pickedFromDiscard = false; hasDrawn = false; lastPickedDiscardId = null;
    showNotification('Kaarkii tuurista ayaad ku soo celisay. Hadda kaar qaado ama tuurista ka qaado.', 3000);
    renderAll();
  });

  socket.on('discardCardUsed', () => {
    myHand.forEach(c => { c.fromDiscard = false; });
    pickedFromDiscard = false;
    lastPickedDiscardId = null;
    renderHeader();
    renderHand();
  });

  socket.on('discardReturnedByTimeout', data => {
    if (socket && data?.playerId === socket.id && data.card?.id) {
      myHand = myHand.filter(card => card.id !== data.card.id);
      myHand.forEach(card => { card.selected = false; card.fromDiscard = false; });
      pickedFromDiscard = false;
      hasDrawn = false;
      lastPickedDiscardId = null;
      renderAll();
    }
  });

  socket.on('autoDiscarded', (data) => {
    const isMe = socket && data.playerId === socket.id;
    if (isMe) {
      isMyTurn = false; hasDrawn = false; pickedFromDiscard = false; lastPickedDiscardId = null;
      if (turnTimerInterval) clearInterval(turnTimerInterval);
      if (data.drawnCard && !myHand.some(c => c.id === data.drawnCard.id)) myHand.push({ ...data.drawnCard, selected: false, fromDiscard: false });
      const discardedCard = data.card;
      if (discardedCard && discardedCard.id) { const idx = myHand.findIndex(c => c.id === discardedCard.id); if (idx !== -1) myHand.splice(idx, 1); }
      myHand.forEach(c => { c.selected = false; c.fromDiscard = false; });
      const cardLabel = discardedCard ? `${discardedCard.value}${discardedCard.suit}` : "Kaar";
      showNotification(`Waqtigii wuu kaa dhammaaday — ${cardLabel} ayaa si toos ah loo tuuray!`, 4000);
    } else {
      const opponent = players.find(p => p && p.id === data.playerId);
      const opponentName = opponent ? opponent.name : "Ciyaaryahan";
      const cardLabel = data.card ? `${data.card.value}${data.card.suit}` : "kaar";
      showNotification(`Waqtiga wuu ka dhammaaday ${opponentName} — waa laga tuuray ${cardLabel}`, 3000);
    }
    renderAll();
  });

  // ─── SESSION FOORO UPDATE — server ayaa diraya dhibcaha ciyaartoyda oo dhan ─
  socket.on('sessionFooroUpdate', data => {
    if (data && data.scores) {
      setSessionScores(data.scores);
      sessionDabaaqPairs = Array.isArray(data.dabaaqPairs) ? data.dabaaqPairs : [];
      if (data.xiiliTarget) {
        xiiliTarget = data.xiiliTarget;
        // Label-ka kaliya cusboonaysii — dots-yada ha la taaban marka gameOver modal hayo
        const tl = $('fooro-target-label');
        if (tl) tl.textContent = `${xiiliTarget} Fooro`;
      }
    }
    saveSessionScores();
    updateFooroPanel();
  });

  socket.on('profilesReset', () => {
    if (myProfileData) {
      myProfileData = { ...myProfileData, score: 0, wins: 0, fooros: 0, games: 0 };
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(myProfileData)); } catch (e) {}
      renderAuthStatus();
    }
    latestLeaderboard = [];
  });

  // Profile-ka joogtada ah ha ka sugin logout/login; server-ku wuxuu diraa
  // nuqulka cusub isla marka ciyaartu dhammaato.
  socket.on('profileScoresUpdate', data => {
    const entry = Array.isArray(data?.profiles)
      ? data.profiles.find(item =>
          normalizeName(item?.profile?.name) === normalizeName(myProfileName)
        )
      : null;
    if (!entry?.profile) return;
    myProfileData = { ...myProfileData, ...entry.profile };
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(myProfileData)); } catch (e) {}
    renderAuthStatus();
  });

  // ─── SEASONENDED — server ayaa diraya marka target-ka la gaaro ────────────────
  socket.on('seasonEnded', data => {
    if (data.scores) {
      setSessionScores(data.scores); // fallback-ka sidoo kale cusboonaysii
    }
    if (data.target) xiiliTarget = data.target;
    saveSessionScores();
    updateFooroPanel();

    // Sug ciyaarta in ay dhammaato, ka dib muuji modal-ka
    setTimeout(() => {
      const modal = $('season-modal');
      if (!modal || !modal.classList.contains('hidden')) return;

      const body = $('season-modal-body');
      if (body) body.textContent = `${data.loser || '?'} wuxuu galay ${xiiliTarget} fooro — Xilli ciyaareedka wuu dhammaday!`;

      const scoresEl = $('season-final-scores');
      if (scoresEl && data.scores) {
        const sorted = Object.entries(data.scores)
          .sort((a, b) => (a[1].fooros || 0) - (b[1].fooros || 0) || (b[1].wins || 0) - (a[1].wins || 0));
        scoresEl.innerHTML = sorted.map(([name, d]) => {
          const isLoser = name === data.loser;
          const fooros  = d.fooros || 0;
          const wins    = d.wins   || 0;
          const isMe    = (myName && name.toLowerCase() === myName.toLowerCase()) ||
                          (myProfileName && name.toLowerCase() === myProfileName.toLowerCase());
          return `<div class="fooro-row${isLoser ? ' fooro-danger' : ''}${isMe ? ' fooro-me' : ''}">` +
            `<span class="fooro-name">${name}${isMe ? ' ★' : ''}${isLoser ? ' ❌' : ''}</span>` +
            `<span class="fooro-wins" style="color:#2ecc71">${wins}G</span>` +
            `<span style="color:${isLoser ? '#e74c3c' : '#aaa'};font-weight:700">${fooros} fooro</span>` +
            `</div>`;
        }).join('');
      }
      modal.classList.remove('hidden');
    }, 2000); // Sug 2 second ka dib gameOver modal
  });

socket.on('gameOver', data => {
  clearInterval(turnTimerInterval);
  sessionStorage.removeItem(SESSION_KEY);
  if (data.allPlayers) { players = data.allPlayers || []; }
  renderAll();

  const isMeWinner = socket && data.winnerId === socket.id;
  const allGamePlayers = data.allPlayers || [];
  let fooroTarget = data.fooroTargetId ? allGamePlayers.find(p => p.id === data.fooroTargetId) : null;
  if (!fooroTarget) fooroTarget = applyFooroLogic(data.winnerId, data.providerId, allGamePlayers);

  if (isMeWinner && fooroTarget && !fooroTarget.isBot && !data.fooroReturnedToOwnerName) {
    // Server-ku wuxuu hore ugu daray 101 dhibcood qofka fooradu ku dhacday.
    // Ha ka darin mar labaad client-ka, taas oo abuuri lahayd 202 dhibcood.
    showNotification(`FOORO! ${fooroTarget.name} ayaa 101 dhibco helay!`, 4000);
  }

  if (data.sessionScores) {
    setSessionScores(data.sessionScores);
  } else {
    const gameOverKey = `${data.winnerId || ''}|${data.providerId || ''}|${fooroTarget ? fooroTarget.id : ''}|${allGamePlayers.map(p => p.name).join(',')}`;
    const now = Date.now();
    const alreadyApplied = lastAppliedGameOverKey === gameOverKey && now - lastAppliedGameOverAt < 10000;
    if (!alreadyApplied) {
      lastAppliedGameOverKey = gameOverKey;
      lastAppliedGameOverAt = now;
      allGamePlayers.forEach(p => ensureSessionPlayer(p.name));
      const _winner = allGamePlayers.find(p => p.id === data.winnerId);
      const providerPlayer = data.providerId ? allGamePlayers.find(p => p.id === data.providerId) : null;
      const xiradTurub = Boolean(providerPlayer && providerPlayer.id !== data.winnerId);
      const isDabaaq = data.dabaaqType === 'negative' || data.dabaaqType === 'positive';

      if (_winner) {
        ensureSessionPlayer(_winner.name);
        const wk = normalizeName(_winner.name);

        if (fooroTarget) {
          ensureSessionPlayer(fooroTarget.name);
          const fk = normalizeName(fooroTarget.name);

          const winnerWins   = sessionFooros[wk].wins   || 0;
          const winnerFooros = sessionFooros[wk].fooros || 0;
          const victimWins   = sessionFooros[fk].wins   || 0;
          const victimFooros = sessionFooros[fk].fooros || 0;
          const winnerNet = winnerWins - winnerFooros;

          const equalPositivePlayer = winnerNet > 0
            ? allGamePlayers.find(p => {
                if (!p || p.id === data.winnerId || p.id === fooroTarget.id) return false;
                ensureSessionPlayer(p.name);
                const pk = normalizeName(p.name);
                const equalScore = sessionFooros[pk] || { wins: 0, fooros: 0 };
                return (equalScore.wins || 0) - (equalScore.fooros || 0) === winnerNet;
              })
            : null;
          const negativePairOther = data.dabaaqType === 'negative' && data.dabaaqPair
            ? allGamePlayers.find(p => {
                if (!p || p.id === data.winnerId) return false;
                const nameKey = normalizeName(p.name);
                return nameKey === normalizeName(data.dabaaqPair.player1) ||
                       nameKey === normalizeName(data.dabaaqPair.player2);
              })
            : null;
          const negativePairOtherKey = negativePairOther
            ? normalizeName(negativePairOther.name)
            : '';
          if (negativePairOther) ensureSessionPlayer(negativePairOther.name);
          let winnerWinsAfterEqualDabaaq = winnerWins;

          if (equalPositivePlayer) {
            const equalKey = normalizeName(equalPositivePlayer.name);
            const equalScore = sessionFooros[equalKey];
            const equalNet = (equalScore.wins || 0) - (equalScore.fooros || 0);

            winnerWinsAfterEqualDabaaq += Math.max(0, equalNet);
            // La mid nooca server-ka: +1 Dabaaq laga jaro wuxuu noqdaa
            // 0, ee ma noqonayo -1 (ama 1W-1F oo qarsoon).
            const equalAfter = Math.max(0, equalNet - 1);
            equalScore.wins = equalAfter;
            equalScore.fooros = 0;
            equalScore.fooroOwners = [];
          }

           /*
            * Score-kan fallback-ka ahi waa inuu la mid noqdaa server-ka.
            * Fooro-target-ka oo hore u degay ama la nadiifiyay ma beddelayo
            * xeerka guuleystaha: haddii uu hayay Fooro, waa laga saaraa;
            * guul cusub looma siinayo. Branch-kii hore wuxuu Abshir -1
            * uga dhigay +1 isagoo Fooradii kaliya wareejin lahaa.
            */
           if (data.dabaaqType === 'negative') {
            const dabaaqAmount = Math.max(1, Number(data.dabaaqPair?.amount) || 1);
             // La mid nooca server-ka: -1 -> +1, -2 -> 0, -3 -> -1.
             const winnerAfterNet = Math.min(1, winnerNet + 2);
             sessionFooros[wk].wins = Math.max(0, winnerAfterNet);
             sessionFooros[wk].fooros = Math.max(0, -winnerAfterNet);
            if (negativePairOtherKey && sessionFooros[negativePairOtherKey]) {
              sessionFooros[negativePairOtherKey].wins = 0;
              sessionFooros[negativePairOtherKey].fooros += dabaaqAmount;
            }
            if (fk === negativePairOtherKey) {
              sessionFooros[fk].fooros += 1;
            } else {
              sessionFooros[fk].fooros = victimFooros + 1;
            }
          } else if (data.dabaaqType === 'positive') {
            sessionFooros[wk].wins   = winnerWinsAfterEqualDabaaq + victimWins + 1;
            sessionFooros[fk].wins   = 0;
            sessionFooros[fk].fooros = (sessionFooros[fk].fooros || 0) + 1;
          } else if (isDabaaq) {
            sessionFooros[wk].wins   = winnerWinsAfterEqualDabaaq + 1;
            sessionFooros[fk].fooros = (sessionFooros[fk].fooros || 0) + 1;
          } else {
            if (winnerFooros > 0) {
              sessionFooros[wk].fooros = Math.max(0, winnerFooros - 1);
            } else {
              sessionFooros[wk].wins = winnerWins + 1;
            }
            sessionFooros[fk].fooros++;
          }

          const hoosgalePlayer = allGamePlayers.find(
            p => p.id !== data.winnerId && p.hoosgale
          );
          if (hoosgalePlayer) {
            ensureSessionPlayer(hoosgalePlayer.name);
            const hk = normalizeName(hoosgalePlayer.name);
            const hoosgaleIsFooroVictim =
              fooroTarget && hoosgalePlayer.id === fooroTarget.id;
            // Haddii Hoosgale-gu yahay isla victim-ka Foorada, hal Fooro
            // ayaa lagu dari doonaa qaybta hoose; wins-- halkan ha lagu
            // darin si qofka laba jeer loo ciqaabin.
            if (!hoosgaleIsFooroVictim && (sessionFooros[hk].wins || 0) > 0) {
              sessionFooros[hk].wins = Math.max(0, sessionFooros[hk].wins - 1);
            }
            if (!hoosgaleIsFooroVictim) {
              sessionFooros[hk].fooros = (sessionFooros[hk].fooros || 0) + 1;
            }
            serverSessionScores[hk].wins = sessionFooros[hk].wins || 0;
            serverSessionScores[hk].fooros = sessionFooros[hk].fooros || 0;
          }

          const totalNetAfterBeforeWinnerBalance = Object.values(sessionFooros).reduce(
            (sum, score) => sum + (Number(score?.wins) || 0) - (Number(score?.fooros) || 0),
            0
          );
          const balanceCorrection = -totalNetAfterBeforeWinnerBalance;
          if (balanceCorrection !== 0) {
            const currentWinnerNet =
              (sessionFooros[wk].wins || 0) - (sessionFooros[wk].fooros || 0);
            const correctedWinnerNet = currentWinnerNet + balanceCorrection;
            sessionFooros[wk].wins = Math.max(0, correctedWinnerNet);
            sessionFooros[wk].fooros = Math.max(0, -correctedWinnerNet);
          }

          serverSessionScores[fk].fooros = sessionFooros[fk].fooros || 0;
          serverSessionScores[fk].wins = sessionFooros[fk].wins || 0;
          if (equalPositivePlayer) {
            const equalKey = normalizeName(equalPositivePlayer.name);
            serverSessionScores[equalKey].fooros = sessionFooros[equalKey].fooros || 0;
            serverSessionScores[equalKey].wins = sessionFooros[equalKey].wins || 0;
          }
          if (negativePairOtherKey && serverSessionScores[negativePairOtherKey]) {
            serverSessionScores[negativePairOtherKey].fooros = sessionFooros[negativePairOtherKey].fooros || 0;
            serverSessionScores[negativePairOtherKey].wins = sessionFooros[negativePairOtherKey].wins || 0;
          }
        } else {
          sessionFooros[wk].wins++;
        }

        serverSessionScores[wk].fooros = sessionFooros[wk].fooros || 0;
        serverSessionScores[wk].wins = sessionFooros[wk].wins || 0;
      }
    }
  }

  saveSessionScores();
  updateFooroPanel();
  setTimeout(checkSeasonEnd, 3500);

  setTimeout(() => {
    const modal = $('gameover-modal');
    if (modal) modal.classList.remove('hidden');

    const allP = allGamePlayers;
    const winnerPlayer = allP.find(p => p.id === data.winnerId);
    const winnerIsBot = winnerPlayer ? winnerPlayer.isBot : false;
    const providerPlayer = data.providerId ? allP.find(p => p.id === data.providerId) : null;
    const xiradTurub = Boolean(providerPlayer && providerPlayer.id !== data.winnerId);

    const icon = $('modal-icon');
    const title = $('modal-title');
    const body = $('modal-body');
    const t = somaliGameText(isMeWinner);

    const finishText = data.allBatuuto
      ? `Saddex ciyaaryahan ayaa galay BATUUTO; ${data.winnerName} ayaa si toos ah u guuleystay.`
      : buildFinishText(t, isMeWinner, data.winnerName, xiradTurub ? providerPlayer : null);

    if (isMeWinner) {
      if (icon) icon.textContent = "🏆";
      if (title) title.textContent = t.winner.toUpperCase() + "!";
      if (body) body.innerHTML = `${t.congratulations}, <span style="color:#f1c40f;font-weight:900">${myName}</span>!<br><span style="color:#2ecc71;font-size:0.95em;font-weight:600">${finishText}</span>`;
    } else {
      if (icon) icon.textContent = winnerIsBot ? "🤖" : "🃏";
      if (title) title.textContent = "CIYAARTU WAA DHAMMAATAY";
      const wLabel = `<span style="color:#2ecc71;font-weight:700">${data.winnerName}${winnerIsBot ? " 🤖" : ""}</span>`;
      if (body) body.innerHTML = `${wLabel} baa guuleystay!<br><span style="color:#aaa;font-size:0.9em">${finishText}</span>`;
    }

    const openInfo = $('modal-open-info');
    if (openInfo) {
      let xiradLine = '';
      const isDabaaq = data.dabaaqType === 'negative' || data.dabaaqType === 'positive';

      if (xiradTurub) {
        const victim = fooroTarget ? fooroTarget.name : "Ciyaartoy kale";
        let mathExplanation = '';
        if (isDabaaq) {
          let dabaaqLabel = '';

          const pair = data.dabaaqPair;
          const winnerIsPlayer1 =
            pair &&
            normalizeName(pair.player1) === normalizeName(data.winnerName);
          const takenFromName = winnerIsPlayer1
            ? pair?.player2
            : pair?.player1;
          const takenByName = data.winnerName;
          const takenFromBefore = winnerIsPlayer1
            ? pair?.player2Before
            : pair?.player1Before;
          const takenFromAfter = winnerIsPlayer1
            ? pair?.player2After
            : pair?.player1After;
          const takenByBefore = winnerIsPlayer1
            ? pair?.player1Before
            : pair?.player2Before;
          const takenByAfter = winnerIsPlayer1
            ? pair?.player1After
            : pair?.player2After;

          if (
            takenFromName &&
            takenFromBefore &&
            takenFromAfter &&
            takenByBefore &&
            takenByAfter
          ) {
            const formatScoreHtml = (score, isBefore) => {
              const net = Number(score?.net);
              if (!Number.isFinite(net)) return '<span>—</span>';
              const color = isBefore
                ? '#3498db'
                : net < 0
                  ? '#e74c3c'
                  : '#2ecc71';
              const formatted = net >= 0 ? `+${net}` : `${net}`;
              return `<span style="color:${color};font-weight:800">${formatted}</span>`;
            };

            dabaaqLabel = `
              <span style="color:#f1c40f;font-weight:700">
                ${escapeHistoryHtml(takenFromName)}
              </span>
              (${formatScoreHtml(takenFromBefore, true)} hore
              ${formatScoreHtml(takenFromAfter, false)} hadda)
              <b>vs</b>
              <span style="color:#f1c40f;font-weight:700">
                ${escapeHistoryHtml(takenByName)}
              </span>
              (${formatScoreHtml(takenByBefore, true)} hore
              ${formatScoreHtml(takenByAfter, false)} hadda)
            `;
          } else {
            // Fallback haddii client-ku helo gameOver data duug ah
            // oo aan lahayn score-kii hore iyo kan hadda.
            dabaaqLabel = data.dabaaqType === 'negative'
              ? 'fooro iyo fooro (-1 vs -1)'
              : 'dabaaq 1 iyo 1 (+3 guuleystaha)';
          }

          mathExplanation = `
            <div style="
              margin-top:6px;
              padding-top:6px;
              border-top:1px dashed rgba(241,196,15,0.4);
              font-size:0.9em;
              line-height:1.5;
            ">
              ⚖️ <b>DABAAQ:</b> Xaalad isku mid ah ayaa dhacday:<br>
              ${dabaaqLabel}
            </div>
          `;
        }
        xiradLine = `<div style="margin-bottom:10px;padding:8px 10px;background:rgba(231,76,60,0.12);border-left:3px solid #e74c3c;border-radius:6px;font-size:0.85em;color:#e0e0e0;line-height:1.4;">♠️ <span style="color:#f1c40f;font-weight:700">${data.winnerName}</span> ayaa ku xiray <span style="color:#e74c3c;font-weight:700">${victim}</span>.${mathExplanation}</div>`;
      }

      const rows = allP.map(p => {
        const isMeP = socket && p.id === socket.id;
        const pt = somaliGameText(isMeP);
        const isWinner = p.id === data.winnerId;
         const isFooro =
            fooroTarget &&
            !data.fooroReturnedToOwnerName &&
            p.id === fooroTarget.id;
        const handCount = (p.hand || []).length;
        const handPts = (p.hand || []).reduce((s, c) => s + (c.points || 0), 0);
        
        let badgeHtml = '';
        if (isFooro) badgeHtml += `<span style="font-size:0.75em;background:#e74c3c;color:#fff;padding:1px 5px;border-radius:4px;margin-left:4px">FOORO</span>`;
        
        const nameHtml = isMeP
          ? `<span style="color:#f1c40f;font-weight:700">${pt.name(true, p.name)}</span>${badgeHtml}`
          : isWinner ? `<span style="color:#2ecc71;font-weight:700">${p.name}${p.isBot ? ' 🤖' : ''}</span>${badgeHtml}`
          : isFooro ? `<span style="color:#e74c3c;font-weight:700">${p.name}</span>${badgeHtml}`
          : `<span style="color:#ccc">${p.name}</span>${badgeHtml}`;
          
        let statusHtml;
        if (isWinner) statusHtml = `<span style="color:#2ecc71;font-weight:700">✅ ${pt.winner}</span>`;
        else if (p.isOpened) statusHtml = `<span style="color:#f1c40f">📋 ${pt.opened}</span> · <span style="color:${handCount === 0 ? '#2ecc71' : '#e74c3c'}">${handCount === 0 ? '0 kaar ✓' : `${handCount} kaar (${handPts} dh)`}</span>`;
        else statusHtml = `<span style="color:#e74c3c">❌ ${pt.notOpened}</span> · <span style="color:#e74c3c;font-size:0.85em">${handCount} kaar (${handPts} dh)${isFooro ? ' · + Fooro!' : ''}</span>`;
        
        const rowBg = isFooro ? 'background:rgba(231,76,60,0.08);' : (isWinner ? 'background:rgba(46,204,113,0.06);' : '');
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 4px;border-bottom:1px solid rgba(255,255,255,0.07);${rowBg}"><span>${nameHtml}</span><span>${statusHtml}</span></div>`;
      }).join('');

      let fooroLine = '';
      if (fooroTarget) {
        const fooroHandPts = (fooroTarget.hand || []).reduce((s, c) => s + (c.points || 0), 0);
        const sababta = fooroTarget.hoosgale
          ? `wuxuu galay <span style="color:#8e44ad;font-weight:700">BATUUTO (Hoosgale)</span> — dib ayaa loogu celiyay kaararkiisii turub qaadashada`
          : `${fooroTarget.isOpened ? '' : 'ma uusan degin — '}wuxuu hayay <span style="color:#e74c3c;font-weight:700">${fooroHandPts} dhibcood</span>`;

        const fooroOwnerName =
          data.fooroOwnerName ||
          (data.fooroOwnerId ? allP.find(p => p.id === data.fooroOwnerId)?.name : null);
        const fooroWasTransferred = data.fooroWasTransferred === true;
        const transferredByName = data.fooroTransferorName || data.winnerName;
        
        if (data.fooroReturnedToOwnerName) {
          fooroLine = `<div style="margin-top:8px;padding:6px 10px;background:rgba(241,196,15,0.12);border-left:3px solid #f1c40f;border-radius:6px;font-size:0.82em;color:#e0e0e0;line-height:1.5;">
            🟡 Fooradii waxay ku noqotay <span style="color:#f1c40f;font-weight:700">${data.fooroReturnedToOwnerName}</span> — halkaas ayay ku baaba'day; qof kale looma darin fooro.
          </div>`;
        } else {
          let ownershipLine = '';
          if (fooroWasTransferred) {
            ownershipLine = `<span style="color:#f1c40f;font-weight:700">${transferredByName}</span> ayaa wareejiyay fooro uu lahaa <span style="color:#f1c40f;font-weight:700">${fooroOwnerName || 'milkiile aan la xaqiijin'}</span>.`;
          } else if (fooroTarget.hoosgale) {
            ownershipLine = `<span style="color:#f1c40f;font-weight:700">${fooroTarget.name}</span> hoosgale ayuu galay; fooro cusub ayaa isaga ku dhacday, mana aha fooro uu qof kale hore u watay.`;
          } else {
            ownershipLine = `<span style="color:#f1c40f;font-weight:700">${data.winnerName}</span> ayaa yeeshay fooro cusub.`;
          }

          fooroLine = `<div style="margin-top:8px;padding:6px 10px;background:rgba(231,76,60,0.12);border-left:3px solid #e74c3c;border-radius:6px;font-size:0.82em;color:#e0e0e0;line-height:1.5;">
            🔴 Fooro ayaa ku dhacday <span style="color:#e74c3c;font-weight:700">${fooroTarget.name}</span> — ${ownershipLine}<br>${sababta}
          </div>`;
        }
      }

      const hoosgaleLine = data.hoosgaleName
        ? `<div style="margin-top:8px;padding:6px 10px;background:rgba(142,68,173,0.12);border-left:3px solid #8e44ad;border-radius:6px;font-size:0.82em;color:#e0e0e0;line-height:1.5;">
          🟣 Hoosgale: <span style="color:#c39bd3;font-weight:700">${data.hoosgaleName}</span> — Turubkii uu degay iyo kii uu gacanta ku hayey waa laga qaaday meesha, fooro cusubna way ku dhacday sababtoo ah wuxuu dhigay ama degay 12 card taas oo ka dhigan in ay u soo hartay 2, kuwaas oo aan noqon karin set (<b>-1</b>).
        </div>`
        : '';
      
      openInfo.innerHTML = `${xiradLine}<div style="font-size:0.85em;width:100%">${rows}</div>${fooroLine}${hoosgaleLine}`;
    }

    const lbWrap = $('modal-leaderboard-wrap');
    const lbEl = $('modal-leaderboard');
    if (lbWrap && lbEl) {
      lbWrap.classList.remove('hidden');
      
      const allScoreKeys = Object.keys(sessionFooros);
      const leaderboardHtml = allScoreKeys.map(k => {
        const sc = sessionFooros[k] || { wins: 0, fooros: 0 };
        const net = (sc.wins || 0) - (sc.fooros || 0);
        const displayName = serverSessionScores[k]?.displayName || k;
        const isMe = normalizeName(displayName) === normalizeName(myName);
        
        let netDisplay = '';
        if (net > 0) netDisplay = `<span style="color:#2ecc71;font-weight:700">+${net}</span>`;
        else if (net < 0) netDisplay = `<span style="color:#e74c3c;font-weight:700">${net}</span>`;
        else netDisplay = `<span style="color:#ccc">0</span>`;

        const nameColor = isMe ? '#f1c40f' : '#fff';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.05);">
          <span style="color:${nameColor};font-weight:${isMe ? '700' : '400'}">${displayName}${isMe ? ' (Adiga)' : ''}</span>
          <span>${netDisplay} <span style="font-size:0.75em;color:#888;">(${sc.wins || 0}W-${sc.fooros || 0}F)</span></span>
        </div>`;
      }).join('');

      lbEl.innerHTML = leaderboardHtml || `<div style="text-align:center;color:#888;">Weli dhibco lama diiwaangelin</div>`;
    } else if (lbWrap) {
      lbWrap.classList.add('hidden');
    }
  }, 3000);
});

function sendChatMessage(message) {
  const cleanMessage = String(message || '').trim().slice(0, 500);
  if (!cleanMessage || !socket || !socket.connected) return false;
  socket.emit('sendChat', cleanMessage);
  return true;
}

socket.on('receiveChat', data => {
  const sender = String(data?.senderName || '').trim();
  const message = String(data?.message || '').trim();
  if (!sender || !message) return;
  showNotification(`${sender}: ${message}`, 5000);
});
  
  // updateScores — xog kaydi, label kaliya cusboonaysii — ciyaarta cusub ayaa dots-yada render-gareysa
  socket.on('updateScores', (data) => {
    if (!data) return;
    if (data.sessionScores) setSessionScores(data.sessionScores);
    if (data.xiiliTarget) {
      xiiliTarget = data.xiiliTarget;
      // Label-ka kaliya cusboonaysii — dots-yada ha la taaban marka gameOver modal hayo
      const tl = $('fooro-target-label');
      if (tl) tl.textContent = `${xiiliTarget} Fooro`;
    }
    saveSessionScores();
  });

  socket.on('hoosgaleTriggered', () => {
    showNotification('HOOSGALE! Kaarahaagii waa laga qaaday.', 5000);
    myHand = []; isOpened = false; iHaveOpened = false; myOpenedSets = [];
    hasDrawn = false; pickedFromDiscard = false; lastPickedDiscardId = null;
    renderAll();
  });

  socket.on('notification', msg => showNotification(msg));

  socket.on('botPickedDiscard', (data) => {
    showNotification(`🤖 ${data.botName} wuxuu tuurista ka qaatay: Lama oga`, 3500);
    const el = $('discard-display');
    if (el) {
      el.classList.add('discard-bot-took');
      setTimeout(() => el.classList.remove('discard-bot-took'), 800);
    }
  });

  socket.on('timerPaused', data => {
    clearInterval(turnTimerInterval);
    showNotification(data.message, 6000);
    const btn = $('btn-pause');
    const isMe = socket && data.activePlayerId === socket.id;
    if (btn && isMe) { btn.textContent = 'Fasax'; btn.dataset.paused = 'true'; btn.style.background = '#f39c12'; }
  });

  socket.on('timerResumed', () => {
    showNotification('Waqtiga dib ayuu bilaabmay!', 2000);
    const btn = $('btn-pause');
    if (btn) { btn.textContent = 'Isuga'; btn.dataset.paused = 'false'; btn.style.background = ''; }
    if (isMyTurn) startTurnTimer();
  });

  socket.on('leaderboardUpdate', data => {
    if (data && data.leaderboard) {
      latestLeaderboard = data.leaderboard;
      if (myProfileName && data.leaderboard) {
        const myEntry = data.leaderboard.find(p => p.name.toLowerCase() === myProfileName.toLowerCase());
        if (myEntry) { myProfileData = { ...myProfileData, ...myEntry }; renderAuthStatus(); }
      }
      const lbEl = $('modal-leaderboard');
      if (lbEl) lbEl.innerHTML = renderLeaderboard(latestLeaderboard);
      if (data.roundDeltas && socket) {
        const myDelta = data.roundDeltas[socket.id];
        if (myDelta) {
          const sign = myDelta.delta > 0 ? '+' : '';
          showNotification(`Dhibacyadaada: ${sign}${myDelta.delta} (Wadarta: ${myDelta.total >= 0 ? '+' : ''}${myDelta.total})`, 5000);
        }
      }
    }
  });

  socket.on('winnerHistoryUpdate', data => {
    renderWinnerHistory(data);
  });

  setInterval(() => { if (socket && socket.connected) socket.emit('ping_keep_alive'); }, 25000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && socket && inGame) socket.emit('request_sync');
});

document.addEventListener('DOMContentLoaded', () => {
  loadSessionScores();
  restoreSavedProfile();
  const _tl = $('fooro-target-label');
  if (_tl) _tl.textContent = `${xiiliTarget} Fooro`;
  const _xs = $('xiili-select');
  if (_xs) {
    _xs.value = String(xiiliTarget);
    _xs.addEventListener('change', () => {
      const v = parseInt(_xs.value, 10);
      if (v === 5 || v === 10) {
        xiiliTarget = v;
        try { localStorage.setItem(TARGET_KEY, String(v)); } catch(e) {}
        if (_tl) _tl.textContent = `${xiiliTarget} Fooro`;
      }
    });
  }
  updateFooroPanel();
  const joinBtn = $('join-btn');
  if (joinBtn) joinBtn.addEventListener('click', joinGame);
  const nameInput = $('name-input');
  if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
  const btnDraw = $('btn-draw');
  if (btnDraw) btnDraw.addEventListener('click', handleDraw);
  const btnPickDiscard = $('btn-pick-discard');
  if (btnPickDiscard) btnPickDiscard.addEventListener('click', handlePickDiscard);
  const btnDhigo = $('btn-dhigo');
  if (btnDhigo) btnDhigo.addEventListener('click', handleDhigo);
  const btnReset = $('btn-reset');
  if (btnReset) btnReset.addEventListener('click', handleReset);
  const btnSort = $('btn-sort');
  if (btnSort) btnSort.addEventListener('click', handleSort);
  const btnTuur = $('btn-tuur');
  if (btnTuur) btnTuur.addEventListener('click', handleTuur);

  const btnAddBots = $('btn-add-bots');
  if (btnAddBots) {
    btnAddBots.addEventListener('click', () => {
      if (!socket) return;
      btnAddBots.disabled = true;
      btnAddBots.textContent = '🤖 Robotyada la keenayaa...';
      stopWaitingCountdown();
      socket.emit('addBots');
    });
  }

  const btnPause = $('btn-pause');
  if (btnPause) {
    btnPause.addEventListener('click', () => {
      if (!isMyTurn) return;
      if (pickedFromDiscard && !isOpened) { if (socket) socket.emit('returnDiscardCard'); return; }
      const isPaused = btnPause.dataset.paused === 'true';
      if (!isPaused) {
        if (socket) socket.emit('pauseTimer');
        btnPause.textContent = 'Fasax'; btnPause.dataset.paused = 'true'; btnPause.style.background = '#f39c12';
        clearInterval(turnTimerInterval);
      } else {
        if (socket) socket.emit('resumeTimer');
        btnPause.textContent = 'Isuga'; btnPause.dataset.paused = 'false'; btnPause.style.background = '';
      }
    });
  }

  const btnForceReset = $('btn-force-reset');
  if (btnForceReset) {
    btnForceReset.addEventListener('click', () => {
      if (!socket) return;
      const gameOverModal = $('gameover-modal');
      if (gameOverModal) gameOverModal.classList.add('hidden');
      isMyTurn = false;
      hasDrawn = false;
      pickedFromDiscard = false;
      lastPickedDiscardId = null;
      if (turnTimerInterval) clearInterval(turnTimerInterval);
      socket.emit('forceResetGame');
    });
  }

  setupFooroPanelControls();
  renderAuthStatus();
  loadWinnerHistory();

  const winnerHistoryModal = $('winner-history-modal');
  const openWinnerHistory = () => {
    if (!winnerHistoryModal) return;
    winnerHistoryModal.classList.remove('hidden');
    loadWinnerHistory();
  };
  const closeWinnerHistory = () => {
    if (winnerHistoryModal) winnerHistoryModal.classList.add('hidden');
  };
  const openWinnerHistoryBtn = $('btn-open-winner-history');
  const gameWinnerHistoryBtn = $('btn-game-history');
  const closeWinnerHistoryBtn = $('btn-close-winner-history');
  if (openWinnerHistoryBtn) openWinnerHistoryBtn.addEventListener('click', openWinnerHistory);
  if (gameWinnerHistoryBtn) gameWinnerHistoryBtn.addEventListener('click', openWinnerHistory);
  if (closeWinnerHistoryBtn) closeWinnerHistoryBtn.addEventListener('click', closeWinnerHistory);
  if (winnerHistoryModal) {
    winnerHistoryModal.addEventListener('click', event => {
      if (event.target === winnerHistoryModal) closeWinnerHistory();
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && winnerHistoryModal && !winnerHistoryModal.classList.contains('hidden')) {
      closeWinnerHistory();
    }
  });

  const refreshWinnerHistoryBtn = $('btn-refresh-winner-history');
  if (refreshWinnerHistoryBtn) refreshWinnerHistoryBtn.addEventListener('click', loadWinnerHistory);
  const clearWinnerHistoryBtn = $('btn-clear-winner-history');
  if (clearWinnerHistoryBtn) clearWinnerHistoryBtn.addEventListener('click', clearWinnerHistory);

  const pinInput = $('auth-pin-input');
  if (pinInput) {
    pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4); });
    pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleAuthSubmit($('btn-auth-register') && $('btn-auth-register').style.display !== 'none' ? 'register' : 'login'); });
  }
  const authNameInput = $('auth-name-input');
  if (authNameInput) authNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { if (pinInput) pinInput.focus(); } });

  try { initSocket(); } catch (err) { console.error('Socket init error:', err); }
});
