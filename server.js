import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, copyFileSync, readdirSync } from 'node:fs';
import { extname, join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as IOServer } from 'socket.io';
import { createWinnerHistoryStore } from './listwinersengine.js';
import { explainGameOver } from './gameover-explanation-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);

function hasIndexFile(directory) {
  try {
    return readdirSync(directory).some(name => /^index(?:_\d+)?\.html$/.test(name));
  } catch {
    return false;
  }
}

const publicCandidates = [
  process.env.PUBLIC_DIR ? resolve(process.env.PUBLIC_DIR) : null,
  join(__dirname, 'public'),
  join(process.cwd(), 'public'),
  join(__dirname, '..', 'public'),
  __dirname,
  join(process.cwd(), 'attached_assets'),
].filter(Boolean);

// The uploaded files may still have Replit's timestamp suffixes and may not
// have been moved into a public/ directory yet. Prefer a real public folder,
// then use the directory containing the uploaded index file.
const PUBLIC = publicCandidates.find(hasIndexFile) || join(__dirname, 'public');

function hasProfileData(directory) {
  try {
    return readdirSync(directory).some(name =>
      /^profiles(?:\.backup)?(?:_\d+)?\.json$/.test(name) ||
      /^sessions(?:_\d+)?\.json$/.test(name)
    );
  } catch {
    return false;
  }
}

const dataCandidates = [
  process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : null,
  ...[__dirname, process.cwd(), join(process.cwd(), 'attached_assets')].filter(Boolean),
].filter(Boolean);
const detectedDataDir = dataCandidates.find(hasProfileData);
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : (detectedDataDir || join(__dirname, 'data'));

// ─── Disk persistence: profiles + xiili sessions ─────────────────────────────
const profilesPath = join(DATA_DIR, 'profiles.json');
const profilesBackupPath = join(DATA_DIR, 'profiles.backup.json');
const sessionsPath = join(DATA_DIR, 'sessions.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function readJsonFile(filePath, fallback = {}) {
  try {
    if (!filePath || !existsSync(filePath)) return fallback;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    console.error(`❌ Lama akhrin karo ${filePath}:`, err.message || err);
    return fallback;
  }
}

// Aqbal labada higgaad ee hore ugu jiray sessions.json. Nooca cusub ee
// server-ku qoro waa "dabaaqPairs", laakiin qaar ka mid ah faylashii hore
// waxay lahaayeen "dabaqPairs". Haddii aan halkaan lagu mideyn, pair-ku
// wuu muuqan karaa faylka balse ciyaarta marka xigta ma isticmaali karto.
function normalizeSavedDabaaqPairs(value) {
  const source = [
    ...(Array.isArray(value?.dabaaqPairs) ? value.dabaaqPairs : []),
    ...(Array.isArray(value?.dabaqPairs) ? value.dabaqPairs : []),
  ];
  const seen = new Set();

  return source
    .filter(pair => pair && pair.player1 && pair.player2)
    .filter(pair => {
      const names = [
        String(pair.player1).trim().toUpperCase(),
        String(pair.player2).trim().toUpperCase(),
      ].sort();
      const key = names.join('|');
      if (names[0] === names[1]) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(pair => ({
      player1: String(pair.player1).trim(),
      player2: String(pair.player2).trim(),
      type: pair.type === 'negative_negative'
        ? 'negative_negative'
        : 'positive_positive',
      amount: Number(pair.amount) || 2,
      ...(pair.createdFrom && typeof pair.createdFrom === 'object'
        ? { createdFrom: pair.createdFrom }
        : {}),
    }));
}


function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data || {}, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

function findDataFile(directory, exactName, pattern) {
  const exactPath = join(directory, exactName);
  if (existsSync(exactPath)) return exactPath;
  try {
    const matches = readdirSync(directory)
      .filter(name => pattern.test(name))
      .sort()
      .reverse();
    return matches.length ? join(directory, matches[0]) : null;
  } catch {
    return null;
  }
}

const profileSeedPath = findDataFile(DATA_DIR, 'profiles.json', /^profiles_\d+\.json$/);
const backupSeedPath = findDataFile(DATA_DIR, 'profiles.backup.json', /^profiles\.backup_\d+\.json$/);
const sessionSeedPath = findDataFile(DATA_DIR, 'sessions.json', /^sessions_\d+\.json$/);

const globalProfiles = readJsonFile(
  profilesPath,
  readJsonFile(profileSeedPath, readJsonFile(backupSeedPath, {})),
);
const globalSessions = readJsonFile(sessionsPath, readJsonFile(sessionSeedPath, {}));
const winnerHistoryPath = join(DATA_DIR, 'listwiners.json');
const winnerHistory = createWinnerHistoryStore(winnerHistoryPath);

function saveProfilesData() {
  atomicWriteJson(profilesPath, globalProfiles);
}

function backupProfilesData() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(profilesPath)) copyFileSync(profilesPath, profilesBackupPath);
    else atomicWriteJson(profilesBackupPath, globalProfiles);
  } catch (err) {
    console.error('❌ Backup profiles waa fashilmay:', err.message || err);
  }
}

function resetAllProfileStats() {
  // Xisaabaadka iyo PIN-yada waa la hayaa; tirakoobka xilli-ciyaareedka
  // (score, guulo, foorooyin iyo ciyaaro) ayaa keliya dib loogu celinayaa eber.
  for (const profile of playerProfiles.values()) {
    profile.score = 0;
    profile.wins = 0;
    profile.fooros = 0;
    profile.games = 0;
  }

  for (const [key, profile] of Object.entries(globalProfiles)) {
    if (!profile || typeof profile !== 'object') continue;
    profile.score = 0;
    profile.wins = 0;
    profile.fooros = 0;
    profile.games = 0;
    globalProfiles[key] = profile;
  }

  // Labada fayl si isku mar ah u cusboonaysii; backup-ga ha sii hayn tiradii
  // hore, taas oo ahayd sababta ay mar kale ugu soo laabanaysay.
  saveProfilesData();
  backupProfilesData();
}

function saveSessionsData() {
  const data = {};
  for (const [key, season] of xiiliSessions.entries()) {
    data[key] = {
      target: season.target,
      scores: season.scores || {},
      // Dabaaqdu room-specific ayay noqotay; lama kaydiyo iyadoo global
      // season-ka lagu wada xiriirinayo.
      dabaaqPairs: [],
      ended: !!season.ended,
    };
  }
  atomicWriteJson(sessionsPath, data);
}

function savePersistentState() {
  saveProfilesData();
  saveSessionsData();
}

setInterval(backupProfilesData, 60 * 60 * 1000).unref?.();

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function resolvePublicFile(requestPath) {
  const rawPath = String(requestPath || '/').split('?')[0];
  const relativePath = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
  const publicRoot = resolve(PUBLIC);
  const exactPath = resolve(publicRoot, relativePath);

  // Do not allow a URL to escape the selected public directory.
  if (exactPath !== publicRoot && !exactPath.startsWith(`${publicRoot}${sep}`)) return null;
  if (existsSync(exactPath)) return exactPath;

  // Uploaded assets can be named index_123.html, script_123.js, and
  // style_123.css. Map the browser's canonical URLs to the newest upload.
  const alias = /^(index|script|style)\.(html|js|css)$/.exec(relativePath);
  if (!alias) return null;
  try {
    const suffix = new RegExp(`^${alias[1]}_\\d+\\.${alias[2]}$`);
    const matches = readdirSync(publicRoot).filter(name => suffix.test(name)).sort().reverse();
    return matches.length ? join(publicRoot, matches[0]) : null;
  } catch {
    return null;
  }
}

function resetAllProfilesAndSessions() {
  const filesToReset = [
    { path: profilesPath, defaultData: {} },
    { path: profilesBackupPath, defaultData: {} },
    { path: sessionsPath, defaultData: {} }
  ];

  filesToReset.forEach(fileObj => {
    try {
      writeFileSync(fileObj.path, JSON.stringify(fileObj.defaultData, null, 2), 'utf8');
      console.log(`✅ Faylka waxaa la nadiifiyay: ${fileObj.path}`);
    } catch (err) {
      console.error(`❌ Khalad ayaa ka dhacay tirtiridda faylka:`, err.message || err);
    }
  });

  if (typeof xiiliSessions !== 'undefined' && xiiliSessions.clear) {
    xiiliSessions.clear();
  }
  if (typeof globalSessions !== 'undefined' && globalSessions && typeof globalSessions === 'object') {
    Object.keys(globalSessions).forEach(key => delete globalSessions[key]);
  }
}

// ─── Static file server ───────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const pathname = requestUrl.pathname;

  if (pathname === '/api/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const apiHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, apiHeaders); res.end(); return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { name, pin } = JSON.parse(body);
        const cleanName = String(name || '').trim();
        if (!cleanName || !/^\d{4}$/.test(String(pin))) {
          res.writeHead(400, apiHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Magaca iyo 4-digit PIN ayaa loo baahan yahay' }));
          return;
        }
        if (getProfile(cleanName)) {
          res.writeHead(409, apiHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Magacaan horey loo diiwaangaliyay' }));
          return;
        }
        const profile = createProfile(cleanName, String(pin));
        res.writeHead(200, apiHeaders);
        res.end(JSON.stringify({ ok: true, profile: { name: profile.name, score: 0, wins: 0, fooros: 0, games: 0 } }));
      } catch { res.writeHead(400, apiHeaders); res.end(JSON.stringify({ ok: false, error: 'Khalad' })); }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { name, pin } = JSON.parse(body);
        const profile = validateProfile(name, pin);
        if (!profile) {
          res.writeHead(401, apiHeaders);
          res.end(JSON.stringify({ ok: false, error: 'Magaca ama PIN-ku waa khalad' }));
          return;
        }
        res.writeHead(200, apiHeaders);
        res.end(JSON.stringify({ ok: true, profile: { name: profile.name, score: profile.score, wins: profile.wins, fooros: profile.fooros, games: profile.games } }));
      } catch { res.writeHead(400, apiHeaders); res.end(JSON.stringify({ ok: false, error: 'Khalad' })); }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/leaderboard') {
    res.writeHead(200, apiHeaders);
    res.end(JSON.stringify({ ok: true, leaderboard: getLeaderboardData() }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/winner-history') {
    res.writeHead(200, apiHeaders);
    res.end(JSON.stringify({ ok: true, ...winnerHistory.getSummary() }));
    return;
  }

  if (req.method === 'DELETE' && pathname === '/api/winner-history') {
    const summary = winnerHistory.clear();
    res.writeHead(200, apiHeaders);
    res.end(JSON.stringify({ ok: true, ...summary }));
    if (typeof io !== 'undefined') io.emit('winnerHistoryUpdate', summary);
    return;
  }

  const filePath = resolvePublicFile(pathname) || resolvePublicFile('/');
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const isApplicationAsset = ['.html', '.js', '.css'].includes(ext);

  try {
    const content = readFileSync(filePath);
    /*
     * Browser-ku ha soo celin nuqul hore oo script/server UI ah.
     * Tani waa muhiim marka fayl la beddelo iyadoo URL-ku yahay isla
     * script.js ama index.html; haddii kale browser-ku wuxuu muujin karaa
     * xisaabtii hore inkastoo server-ka la restart-gareeyay.
     */
    res.writeHead(200, {
      'Content-Type': mime,
      ...(isApplicationAsset
        ? {
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
          }
        : {}),
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── Player Profiles (In-Memory + Disk) ─────────────────────────────────────
function profileKey(name) {
  return String(name || '').toLowerCase().trim();
}

function publicProfile(profile) {
  return {
    name: profile.name,
    score: Number(profile.score) || 0,
    wins: Number(profile.wins) || 0,
    fooros: Number(profile.fooros) || 0,
    games: Number(profile.games) || 0,
  };
}

const playerProfiles = new Map(
  Object.entries(globalProfiles && typeof globalProfiles === 'object' ? globalProfiles : {}).map(([key, profile]) => {
    const cleanProfile = {
      name: profile?.name || key,
      pin: String(profile?.pin || ''),
      score: Number(profile?.score) || 0,
      wins: Math.max(0, Number(profile?.wins) || 0),
      fooros: Math.max(0, Number(profile?.fooros) || 0),
      games: Math.max(0, Number(profile?.games) || 0),
    };
    globalProfiles[key] = cleanProfile;
    return [key, cleanProfile];
  }),
);

// Create the canonical files immediately. This also makes the uploaded
// timestamped profile file usable on the first run and keeps the backup in
// sync even before the first game ends.
  if (!existsSync(profilesPath)) saveProfilesData();
  // profiles.backup.json ha noqon nuqul duugoobay marka server-ku bilaabmo.
  backupProfilesData();

function getProfile(name) {
  return playerProfiles.get(profileKey(name));
}

function createProfile(name, pin) {
  const key = profileKey(name);
  if (playerProfiles.has(key)) return null;
  const profile = { name: name.trim(), pin: String(pin), score: 0, wins: 0, fooros: 0, games: 0 };
  playerProfiles.set(key, profile);
  globalProfiles[key] = profile;
  saveProfilesData();
  return profile;
}

function validateProfile(name, pin) {
  const profile = getProfile(name);
  if (!profile || profile.pin !== String(pin)) return null;
  return profile;
}

function getLeaderboardData() {
  return [...playerProfiles.values()]
    .filter(p => p.games > 0)
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.fooros - b.fooros)
    .map(publicProfile);
}

// ─── Server-side fooro target ─────────────────────────────────────────────────
function firstBatuuto(players, winnerId = null) {
  return (Array.isArray(players) ? players : [])
    .filter(player =>
      player &&
      player.id !== winnerId &&
      player.hoosgale
    )
    .sort((a, b) => {
      const orderA = Number.isFinite(Number(a.hoosgaleOrder))
        ? Number(a.hoosgaleOrder)
        : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(Number(b.hoosgaleOrder))
        ? Number(b.hoosgaleOrder)
        : Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    })[0] || null;
}

function findFooroTarget(winnerId, providerId, players) {
  /*
   * Foorada iyo Dabaaqdu waxay ku xiran yihiin qofkii kaarka tuuray.
   * Fooradu ma wareegi karto qof kale sababtoo ah provider-ku hore ayuu
   * u degay. Tusaale ahaan, haddii Faarax yahay provider-ka, fooradu
   * Faarax ayay ku dhacaysaa; ma u gudbi karto Jimcaale.
   */
  /*
   * Hoosgale/Batuuto waa bartilmaameedka tooska ah ee foorada.
   * Qofka kale ee aan degin (tusaale Faarax) fooro looma saarayo
   * kaliya sababta oo ah hoosgale ayaa wareegga khalday.
   */
  // Haddii ay in ka badan hal qof Batuuto noqdaan, fooradu waxay ku
  // dhacaysaa kii ugu horreeyay ee galay Batuutada, ma aha kii ugu dambeeyay
  // ama qofka ku horreeya array-ga players.
  const hoosgale = firstBatuuto(players, winnerId);
  if (hoosgale) return hoosgale.id;

  const canReceiveFooro = candidate =>
    candidate &&
    candidate.id !== winnerId &&
    !candidate.isOpened &&
    !candidate.isCleared &&
    !candidate.hasPassed;

  if (providerId && providerId !== winnerId) {
    const provider = players.find(p => p.id === providerId);
    /*
     * Provider-ku mararka qaar wuu degi karaa. Qof degay Fooro looma
     * dhigi karo; markaas raadi qofka xiga ee aan degin. Tusaale ahaan:
     * Jaamac wuu degay, sidaas darteed Fooradu waxay ku dhacaysaa Abshir.
     */
    if (canReceiveFooro(provider)) return provider.id;
  }

  /*
   * Fallback marka aanu jirin provider la xaqiijin karo:
   * qofka ka horreeya guuleystaha ayaa laga bilaabaa, laakiin qof
   * hore u degay lama ciqaabi karo. Haddii Abshir degay, tusaale ahaan,
   * raadintu way ka gudbaysaa oo waxay gaadhaysaa Faarax.
   */
  const directFallbackIndex = players.findIndex(p => p.id === winnerId);
  if (directFallbackIndex !== -1 && players.length > 1) {
    for (let step = 1; step <= players.length; step++) {
      const candidate =
        players[(directFallbackIndex - step + players.length) % players.length];
      if (canReceiveFooro(candidate)) return candidate.id;
    }
  }

  return null;
}

function updatePersistentScores(room, scoreResult) {
  const deltas = scoreResult?.deltas || {};
  const roundDeltas = {};
  const updatedProfiles = [];
  room.players.forEach(pl => {
    if (pl.isBot || !pl.profileName) return;
    const profile = getProfile(pl.profileName);
    if (!profile) return;
    const key = normalizeSessionName(pl.name);
    const delta = deltas[key] || { wins: 0, fooros: 0, net: 0 };
    profile.games += 1;
    profile.wins = Math.max(0, (Number(profile.wins) || 0) + (delta.wins || 0));
    profile.fooros = Math.max(0, (Number(profile.fooros) || 0) + (delta.fooros || 0));
    profile.score = (Number(profile.score) || 0) + (delta.net || 0);
    globalProfiles[profileKey(pl.profileName)] = profile;
    roundDeltas[pl.id] = { name: pl.name, delta: delta.net || 0, total: profile.score };
    updatedProfiles.push({ playerId: pl.id, profile: publicProfile(profile) });
  });

  // Qor labada nuqul isla marka round-ku dhammaado. Haddii backup-ga la
  // sugo timer-ka saacaddii, restart ama akhris khaldan wuxuu soo celin
  // karaa dhibcihii hore.
  saveProfilesData();
  backupProfilesData();
  return { roundDeltas, updatedProfiles };
}

// ─── Session Score Tracking ────────────────────────────────────────────────────
const xiiliSessions = new Map();

function normalizeXiiliTarget(target) {
  const parsed = parseInt(target, 10);
  return parsed === 10 ? 10 : 5;
}

function getXiiliSession(target = 5) {
  const normalizedTarget = normalizeXiiliTarget(target);
  const key = String(normalizedTarget);
  if (!xiiliSessions.has(key)) {
    const saved = globalSessions && typeof globalSessions === 'object' ? globalSessions[key] : null;
    xiiliSessions.set(key, {
      target: normalizedTarget,
      scores: saved && typeof saved.scores === 'object' ? saved.scores : {},
      dabaaqPairs: normalizeSavedDabaaqPairs(saved),
      ended: Boolean(saved && saved.ended),
    });
  }
  return xiiliSessions.get(key);
}

function normalizeSessionName(name) {
  return String(name || '').trim().toUpperCase();
}

function ensureSessionScore(scores, name) {
  const cleanName = String(name || '').trim();
  const key = normalizeSessionName(cleanName);
  if (!key) return null;
  if (!scores[key]) {
    scores[key] = {
      wins: 0,
      fooros: 0,
      fooroOwners: [],
      displayName: cleanName
    };
  }
  Object.keys(scores).forEach(oldKey => {
    if (oldKey === key || normalizeSessionName(oldKey) !== key) return;
    scores[key].wins = Math.max(Number(scores[key].wins) || 0, Number(scores[oldKey]?.wins) || 0);
    scores[key].fooros = Math.max(Number(scores[key].fooros) || 0, Number(scores[oldKey]?.fooros) || 0);
    scores[key].fooroOwners = [
      ...(Array.isArray(scores[key].fooroOwners) ? scores[key].fooroOwners : []),
      ...(Array.isArray(scores[oldKey]?.fooroOwners) ? scores[oldKey].fooroOwners : [])
    ].filter(Boolean);
    if (scores[oldKey]?.displayName) scores[key].displayName = scores[oldKey].displayName;
    delete scores[oldKey];
  });
  scores[key].wins = Math.max(0, parseInt(scores[key].wins, 10) || 0);
  scores[key].fooros = Math.max(0, parseInt(scores[key].fooros, 10) || 0);
  scores[key].fooroOwners = (Array.isArray(scores[key].fooroOwners)
    ? scores[key].fooroOwners
    : []
  ).filter(Boolean).slice(0, scores[key].fooros);
  scores[key].displayName = scores[key].displayName || cleanName;
  return scores[key];
}

function fooroOwnersFor(score, fallbackOwner = null) {
  const count = Math.max(0, Number(score?.fooros) || 0);
  const owners = Array.isArray(score?.fooroOwners)
    ? score.fooroOwners.filter(Boolean)
    : [];

  // Foorooyinka hore ee aan lahaansho lagu kaydin waxay helayaan milkiile
  // marka ay wareeg cusub ku dhacaan; foorooyinka cusub mar walba way kaydsan
  // yihiin. Tani waxay si tartiib ah ula jaanqaadaysaa session-yadii hore.
  if (fallbackOwner) {
    while (owners.length < count) owners.push(fallbackOwner);
  }

  return owners.slice(0, count);
}

function scoreNet(score) {
  return (Number(score?.wins) || 0) - (Number(score?.fooros) || 0);
}

function rebalanceScoreMap(scores, preferredName = null) {
  const entries = Object.entries(scores || {});
  if (!entries.length) return null;

  const totalNet = entries.reduce((sum, [, score]) => sum + scoreNet(score), 0);
  if (totalNet === 0) return null;

  /*
   * Haddii session hore u lahaa farqi, sixitaanku wuxuu ku dhacayaa
   * score-ka ugu weyn ee isla dhinaca khaladka ku jira. Tusaale:
   * +7, +1, -3, -2 = +3 => +7 waxaa loo dhigaa +4.
   */
  const preferredKey = normalizeSessionName(preferredName);
  const preferredEntry = preferredKey
    ? entries.find(([key]) => normalizeSessionName(key) === preferredKey)
    : null;
  const candidates = (preferredEntry ? [preferredEntry] : entries
    .filter(([, score]) => totalNet > 0 ? scoreNet(score) > 0 : scoreNet(score) < 0)
    .sort((a, b) =>
      totalNet > 0
        ? scoreNet(b[1]) - scoreNet(a[1])
        : scoreNet(a[1]) - scoreNet(b[1])
    ));
  const [key, current] = candidates[0] || entries[0];
  const correctedNet = scoreNet(current) - totalNet;

  scores[key] = {
    ...current,
    wins: Math.max(0, correctedNet),
    fooros: Math.max(0, -correctedNet),
    fooroOwners: fooroOwnersFor(current).slice(0, Math.max(0, -correctedNet)),
  };

  return { key, previousTotal: totalNet, correctedNet };
}

function attachRoomToXiiliSession(room, target = 5) {
  room.xiiliTarget = normalizeXiiliTarget(target);
  const season = getXiiliSession(room.xiiliTarget);
  room.sessionScores = season.scores;
  return season;
}

function sessionHasPreviousFooro(room) {
  const season = getXiiliSession(room?.xiiliTarget || 5);
  return Object.values(season?.scores || {}).some(
    score => (Number(score?.fooros) || 0) > 0
  );
}

/*
 * Dabaaqda lama dooran karo iyadoo lagu salaynayo order-ka kuraasta.
 * Waxaa jiri kara saddex qof ama ka badan oo isku mar buuxiya shuruudda,
 * sidaas darteed kaydi dhammaan lammaanayaasha suurtogalka ah. Marka
 * ciyaartu dhammaato, applyCorrectDabaaqScores() wuxuu hubinayaa winner-ka
 * iyo provider-ka dhabta ah.
 */
function rebuildDabaaqPairsFromScores(room, season) {
  const players = Array.isArray(room?.players) ? room.players : [];
  const pairs = [];

  for (let i = 0; i < players.length; i++) {
    const p1 = players[i];
    const key1 = normalizeSessionName(p1?.name);
    const score1 = room.sessionScores?.[key1];
    const net1 = scoreNet(score1);
    if (!key1 || !score1) continue;

    for (let j = i + 1; j < players.length; j++) {
      const p2 = players[j];
      const key2 = normalizeSessionName(p2?.name);
      const score2 = room.sessionScores?.[key2];
      const net2 = scoreNet(score2);
      if (!key2 || key1 === key2 || !score2) continue;

      const isPositivePair =
        (net1 > 0 && net2 > 0 && net1 === net2) ||
        (net1 === 1 && net2 > 0) ||
        (net2 === 1 && net1 > 0);
      const isNegativePair = net1 < 0 && net2 < 0;
      if (!isPositivePair && !isNegativePair) continue;

      const amount = isNegativePair
        ? Math.min(Math.abs(net1), Math.abs(net2))
        : 2;

      pairs.push({
        player1: p1.name,
        player2: p2.name,
        type: isPositivePair ? 'positive_positive' : 'negative_negative',
        amount,
        createdFrom: {
          player1Net: net1,
          player2Net: net2,
          dabaaqAmount: amount,
        },
      });
    }
  }

  /*
   * Dabaaqdu waa xeer miis, ma aha xeer ku fidsan dhammaan ciyaartoyda
   * xiiliga. Haddii laba room ay isku mar ciyaarayaan, season.dabaaqPairs
   * waxay keeni lahayd in miis A uu pair ka sameeyo qof miis B jooga.
   */
  room.dabaaqPairs = pairs;
  return pairs;
}

function initializeRoomScores(room, target = 5) {
  const season = attachRoomToXiiliSession(room, target);

  if (season.ended) {
    season.scores = {};
    season.ended = false;
    season.dabaaqPairs = [];
    room.dabaaqPairs = [];
    room.sessionScores = season.scores;
  }

  // Dabaaqda waxaa si gaar ah loogu hayaa room kasta.
  if (!Array.isArray(room.dabaaqPairs)) {
    room.dabaaqPairs = [];
  }

  // Dhammaan ciyaartoyda (dad + robots) waa in panel-ka lagu muujiyo.
  if (room.players && Array.isArray(room.players)) {
    room.players.forEach(p => {
      const playerName = p.name || p.id;
      ensureSessionScore(room.sessionScores, playerName);
    });
  }

  // Haddii session kaydsan uu ka yimid xisaabtii hore ee qaldan,
  // sax wadarta ka hor inta aan panel-ka loo dirin ciyaartoyda.
  rebalanceScoreMap(room.sessionScores);

  /*
   * MUHIIM:
   * Dabaaqda cusub waxaa la diyaarinayaa KALIYA marka ciyaar cusub
   * bilaabanayso.
   *
   * endGame() wuxuu hubintan sameeyaa ka hor inta uusan score-ka
   * ciyaarta dhammaanaya ku darin session-ka.
   */
  if (!room.gameStarted) {
    return season;
  }

  const players = Array.isArray(room.players) ? room.players : [];
  // Rebuild pairs at the start of every new game. A saved list from the
  // previous game can otherwise produce overlapping combinations such as
  // A-B, A-C, and B-C.
  room.dabaaqPairs = [];

  // Ka raadi labo qof oo buuxiya shuruudda Dabaaq:
  // +1 / +1 ama +1 / +wax ka badan = positive Dabaaq
  // -1 / -1 = negative Dabaaq
  //
  // Qofka +1 leh ayaa qaadan kara +1 dheeraad ah iyo foorada
  // marka uu jiro ciyaaryahan kale oo leh +1 ama ka badan.
  const used = new Set();

  for (let i = 0; i < players.length; i++) {
    const p1 = players[i];
    const key1 = normalizeSessionName(p1?.name);

    if (!key1 || used.has(key1)) continue;

    const score1 = room.sessionScores[key1];
    if (!score1) continue;

    const net1 =
      (Number(score1.wins) || 0) -
      (Number(score1.fooros) || 0);

    for (let j = i + 1; j < players.length; j++) {
      const p2 = players[j];
      const key2 = normalizeSessionName(p2?.name);

      if (!key2 || key2 === key1 || used.has(key2)) continue;

      const score2 = room.sessionScores[key2];
      if (!score2) continue;

      const net2 =
        (Number(score2.wins) || 0) -
        (Number(score2.fooros) || 0);

      const isPositivePair =
        (net1 > 0 && net2 > 0 && net1 === net2) ||
        (net1 === 1 && net2 > 0) ||
        (net2 === 1 && net1 > 0);
       // Negative Dabaaq wuxuu ka dhashaa laba ciyaaryahan oo labaduba
       // net-koodu taban yahay; ma aha oo keliya -1/-1. Tusaale ahaan
       // -2 iyo -1 waa lammaane sax ah.
       const isNegativePair = net1 < 0 && net2 < 0;

      if (!isPositivePair && !isNegativePair) continue;

      const pairType = isPositivePair
        ? 'positive_positive'
        : 'negative_negative';

      /*
       * Hubi inaan pair-kan hore loogu kaydin.
       */
       const dabaaqAmount = isNegativePair
         ? Math.min(Math.abs(net1), Math.abs(net2))
         : 2;

      room.dabaaqPairs.push({
        player1: p1.name,
        player2: p2.name,
        type: pairType,
        amount: dabaaqAmount,
        createdFrom: { player1Net: net1, player2Net: net2, dabaaqAmount }
      });

      console.log('🟣 DABAAQ LA HAYO:', {
        player1: p1.name,
        player2: p2.name,
        type: pairType,
        amount: dabaaqAmount
      });

      /*
       * Dhibcaha lama eberaynayo. Labada qof waxay sii haystaan
       * score-koodii hore inta dabaaqdu sugayso ciyaarta soo socota.
       */
      // Ha eberayn labada score: +1/+1 ama -1/-1 waa dabaaqda
      // ciyaarta hadda bilaabanaysa, waxaana la isticmaalaa marka
      // ciyaartu dhammaato.

      used.add(key1);
      used.add(key2);

      break;
    }
  }

  // Recovery pass: ha ku xirnaan order-ka ciyaartoyda ama pair kale oo
  // hore loo helay. Haddii laba ciyaaryahan oo taban ay jiraan, pair-kooda
  // waa in mar walba la kaydiyaa. Amount-ku waa kan ugu yar ee labada
  // fooro: -3/-2 => 2, -4/-7 => 4.
  for (let i = 0; i < players.length; i++) {
    const p1 = players[i];
    const key1 = normalizeSessionName(p1?.name);
    const score1 = room.sessionScores[key1];
    const net1 = scoreNet(score1);
    if (!key1 || net1 >= 0) continue;

    for (let j = i + 1; j < players.length; j++) {
      const p2 = players[j];
      const key2 = normalizeSessionName(p2?.name);
      const score2 = room.sessionScores[key2];
      const net2 = scoreNet(score2);
      if (!key2 || net2 >= 0) continue;

      if (used.has(key1) || used.has(key2)) continue;

      const dabaaqAmount = Math.min(Math.abs(net1), Math.abs(net2));
      room.dabaaqPairs.push({
        player1: p1.name,
        player2: p2.name,
        type: 'negative_negative',
        amount: dabaaqAmount,
        createdFrom: { player1Net: net1, player2Net: net2, dabaaqAmount }
      });
      used.add(key1);
      used.add(key2);
      console.log('🔴 DABAAQ TABAN LA SOO CELIYAY:', {
        player1: p1.name,
        player2: p2.name,
        amount: dabaaqAmount
      });
      break;
    }
  }

  // Pair hore loo kaydiyay ha qaadan amount duugoobay. Haddii score-yadu
  // yihiin -3/-2, amount-ku waa 2; haddii ay yihiin -4/-7, waa 4.
  room.dabaaqPairs.forEach(pair => {
    if (pair?.type !== 'negative_negative') return;
    const first = room.sessionScores[normalizeSessionName(pair.player1)];
    const second = room.sessionScores[normalizeSessionName(pair.player2)];
    const firstNet = scoreNet(first);
    const secondNet = scoreNet(second);
    if (firstNet < 0 && secondNet < 0) {
      pair.amount = Math.min(Math.abs(firstNet), Math.abs(secondNet));
      pair.createdFrom = {
        ...(pair.createdFrom || {}),
        player1Net: firstNet,
        player2Net: secondNet,
        dabaaqAmount: pair.amount
      };
    }
  });

  // Qodobka ugu dambeeya ayaa ka sarreeya generation-kii hore:
  // pair-yada waxaa lagu cusboonaysiiyaa dhammaan score-yada hadda jira,
  // mana jiri doono pair ku xiran order-ka ciyaartoyda.
  rebuildDabaaqPairsFromScores(room, season);
  saveSessionsData();
  return season;
}

function addScoreDelta(deltas, name, delta) {
  const key = normalizeSessionName(name);
  if (!key) return;
  if (!deltas[key]) deltas[key] = { wins: 0, fooros: 0, net: 0 };
  deltas[key].wins += delta.wins || 0;
  deltas[key].fooros += delta.fooros || 0;
  deltas[key].net += delta.net || 0;
}

function findNextPositiveScoreHolder(room, scores, startName, stopName, excludedNames = []) {
  const players = Array.isArray(room?.players) ? room.players : [];
  const excluded = new Set(excludedNames.map(normalizeSessionName));
  const startIndex = players.findIndex(
    p => normalizeSessionName(p?.name) === normalizeSessionName(startName)
  );
  if (startIndex === -1) return null;
  const stopKey = normalizeSessionName(stopName);

  // Dabaaqdu waxay ka bilaabataa qofka ku xiga ee la yaqaan.
  // Haddii uusan lahayn score wanaagsan, qofka xiga ayaa la eegayaa.
  for (let offset = 1; offset < players.length; offset++) {
    const candidate = players[(startIndex + offset) % players.length];
    const candidateKey = normalizeSessionName(candidate?.name);
    if (candidateKey === stopKey) break;
    if (!candidateKey || excluded.has(candidateKey)) continue;
    const score = scores?.[candidateKey];
    const net = (Number(score?.wins) || 0) - (Number(score?.fooros) || 0);
    if (net > 0) return candidate.name;
  }
  return null;
}

function canonicalScore(net) {
  const value = Number(net) || 0;
  return {
    wins: Math.max(0, value),
    fooros: Math.max(0, -value),
  };
}

function debugNetLine(scores) {
  return Object.entries(scores || {})
    .map(([key, s]) => `${s?.displayName || s?.name || key}:${(Number(s?.wins) || 0) - (Number(s?.fooros) || 0)}`)
    .join(' | ');
}

/*
 * Xogta score-ku waxay u jiri kartaa si wadaag ah inta lagu jiro xiili,
 * laakiin qofka browser-ka jooga waa inuu arkaa oo keliya miiskiisa.
 * Sidaas darteed dhammaan score broadcasts-ka waxaa lagu maraa filter-kan.
 */
function getRoomVisibleScores(room, scores = room?.sessionScores) {
  const visible = {};
  const players = Array.isArray(room?.players) ? room.players : [];

  players.forEach(player => {
    const name = String(player?.name || '').trim();
    const key = normalizeSessionName(name);
    if (!key) return;

    const score = scores?.[key] || {};
    visible[key] = {
      wins: Math.max(0, Number(score.wins) || 0),
      fooros: Math.max(0, Number(score.fooros) || 0),
      fooroOwners: Array.isArray(score.fooroOwners)
        ? score.fooroOwners.filter(Boolean).slice(0, Math.max(0, Number(score.fooros) || 0))
        : [],
      displayName: name || score.displayName || key,
    };
  });

  return visible;
}

function applyCorrectDabaaqScores(
  io,
  room,
  winnerName,
  providerName,
  victimName = null
) {
  console.log('DABAAQ IN:', {
    winnerName,
    providerName,
    victimName
  });

  const target = room.xiiliTarget || 5;
  const season = getXiiliSession(target);

  if (season?.ended) {
    return {
      scores: room.sessionScores,
      deltas: {},
      dabaaqType: null
    };
  }

  attachRoomToXiiliSession(room, target);

  /*
   * Hubi in dabaaqPairs jiro. Pair-yadu waxay ku xiran yihiin miiskan,
   * mana aha season-ka guud.
   */
  if (!Array.isArray(room.dabaaqPairs)) {
    room.dabaaqPairs = [];
  }

  /*
   * Copy si aan si toos ah ugu dhaawicin sessionScores
   * inta aan xisaabinta wadno.
   */
  const scores = JSON.parse(
    JSON.stringify(room.sessionScores || {})
  );
  const beforeScores = room.sessionScores || {};

  const deltas = {};

  const winner = ensureSessionScore(scores, winnerName);

  if (!winner) {
    return {
      scores: room.sessionScores,
      deltas,
      dabaaqType: null
    };
  }

  const winnerKey = normalizeSessionName(winnerName);
  const providerKey = normalizeSessionName(providerName);
  const victimKey = normalizeSessionName(victimName);

  const winnerPlayer = room.players?.find(
    player => normalizeSessionName(player?.name) === winnerKey
  );
  const hoosgalePlayer = firstBatuuto(room.players, winnerPlayer?.id);
  const netOf = score =>
    (Number(score?.wins) || 0) -
    (Number(score?.fooros) || 0);
  const scoreSnapshot = (name, scoreMap) => {
    const key = normalizeSessionName(name);
    const score = key ? scoreMap?.[key] : null;
    return {
      name,
      net: netOf(score),
      wins: Number(score?.wins) || 0,
      fooros: Number(score?.fooros) || 0,
    };
  };
  /*
   * Haddii session-kii hore uusan hayn owner-ka foorada, ha ku qorin
   * guuleystaha si toos ah. Xaaladda uu guuleystuhu ka qaaday kaarka
   * provider-ka, qofka kaarka bixiyay ayaa ah owner-ka ugu macquulsan.
   *
   * Tusaale:
   *   Jaamac  -1  (guuleystay)
   *   Abshir  +1  (fooradu isaga ayay ku dhacday / kaarkiisa ayaa laga qaatay)
   *
   * Haddii fooroOwners madhan tahay, fallback-ku waa inuu noqdaa Abshir,
   * ee ma aha Jaamac. Tani waxay saameysaa magaca lahaanshaha oo keliya;
   * xisaabta score-ka lama beddelayo.
   */
  const ownerFallbackName =
    providerName &&
    victimName &&
    normalizeSessionName(providerName) === normalizeSessionName(victimName)
      ? providerName
      : winnerName;
  const winnerFooroOwners = fooroOwnersFor(winner, ownerFallbackName);
  const winnerHadFooro = (Number(winner.fooros) || 0) > 0;
  const winnerScoreBefore = netOf(winner);
  // Fooro hore waxaa la wareejiyaa oo keliya haddii guuleystuhu
  // score ahaan taban yahay. Haddii uu yahay 0 ama ka sarreeyo,
  // Foorada ku dhacaysa qofka kale waa fooro cusub, xitaa haddii
  // kaydku weli leeyahay fooroOwner hore.
  const transfersExistingFooro = winnerHadFooro && winnerScoreBefore < 0;
  let transferredFooroOwnerName = null;
  let fooroWasTransferred = false;
  let fooroReturnedToOwnerName = null;

  /*
   * ==========================================================
   * 1. MARKA HORE: raadi Dabaaq sax ah oo labada dhinac khuseeya
   * ==========================================================
   *
   * Ciyaarta marka ay bilaabato waxaa la sameeyaa snapshot ku jira
   * room.activeDabaaqPairs. Taasi waxay ka ilaalisaa pair-ka in uu lumo
   * haddii room kale ama sync kale uu session-ka dib u lifaaqo.
   */
  let dabaaqPairIndex = -1;
  let dabaaqPair = null;
  const pendingPairs = Array.isArray(room.activeDabaaqPairs) && room.activeDabaaqPairs.length
    ? room.activeDabaaqPairs
    : room.dabaaqPairs;

  // Tallaabada 1aad: Raadi pair-ka winner-ka iyo qofka Fooradu ku
  // dhacday. Provider-ku waa qofka kaarkiisa laga qaatay oo keliya;
  // ma aha qofka Dabaaqda lagu go'aaminayo.
  for (let i = 0; i < pendingPairs.length; i++) {
    const pair = pendingPairs[i];

    const p1 = normalizeSessionName(pair.player1);
    const p2 = normalizeSessionName(pair.player2);
    const pairHasWinner = winnerKey === p1 || winnerKey === p2;
    const pairOtherKey = winnerKey === p1 ? p2 : p1;

    if (
      pairHasWinner &&
      (pairOtherKey === victimKey || (!victimKey && pairOtherKey === providerKey))
    ) {
      dabaaqPairIndex = i;
      dabaaqPair = pair;
      break;
    }
  }

  /*
   * Provider-ka iyo qofka Dabaaqda ku lammaan mar walba isku qof ma aha.
   *
   * Tusaale:
   *   Abshir  -1  (wuxuu ciyaarta xiray)
   *   Faarax  +3  (kaarkiisa ayaa la qaatay; Fooradu isaga ayay ku dhacaysaa)
   *   Jaamac  -2  (Abshir-Jaamac waa negative Dabaaq)
   *
   * Xaaladdan victimKey waa Faarax, sidaas darteed hubintii kore ma heli
   * lahayn Abshir-Jaamac. Halkan pair-ka waxaa lagu xaqiijinayaa noociisa
   * iyo score-yadii ka hor xiritaanka, iyadoo aan provider/victim lagu
   * qaldin lammaanaha Dabaaqda.
   */
  if (!dabaaqPair) {
    for (let i = 0; i < pendingPairs.length; i++) {
      const pair = pendingPairs[i];
      const p1 = normalizeSessionName(pair?.player1);
      const p2 = normalizeSessionName(pair?.player2);
      const pairHasWinner = winnerKey === p1 || winnerKey === p2;
      if (!pairHasWinner) continue;

      const pairOtherKey = winnerKey === p1 ? p2 : p1;
      const otherScore = scores[pairOtherKey];
      const otherNet = netOf(otherScore);
      const winnerNet = netOf(winner);

      const isNegativeDabaaq =
        pair.type === 'negative_negative' &&
        winnerNet < 0 &&
        otherNet < 0;
      const isPositiveDabaaq =
        pair.type === 'positive_positive' &&
        ((winnerNet > 0 && otherNet > 0 && winnerNet === otherNet) ||
          (winnerNet === 1 && otherNet > 0) ||
          (otherNet === 1 && winnerNet > 0));

      if (isNegativeDabaaq || isPositiveDabaaq) {
        dabaaqPairIndex = i;
        dabaaqPair = pair;
        break;
      }
    }
  }

  /*
   * Ha isticmaalin pair uu winner-ku keligiis ku jiro.
   *
   * Hoosgale awgiis providerName iyo victimName way kala duwanaan
   * karaan: Abshir wuxuu ka qaadan karaa Faarax, laakiin Fooradu waxay
   * ku dhici kartaa Jaamac. Xaaladdaas Dabaaqdu waa Abshir-Jaamac.
   *
   * Snapshot-ku mararka qaarkood wuu duugoobi karaa, sidaas darteed haddii
   * pair-ka saxda ahi uusan snapshot-ka ku jirin, ka samee hadda iyadoo
   * victim-ka la doorbidayo, provider-kana fallback laga dhiganayo.
   */
  if (!dabaaqPair) {
    const relatedNames = [victimName, providerName]
      .filter(Boolean)
      .filter(name => normalizeSessionName(name) !== winnerKey);

    for (const relatedName of relatedNames) {
      const relatedKey = normalizeSessionName(relatedName);
      const relatedScore = scores[relatedKey];
      const winnerNet = netOf(winner);
      const relatedNet = netOf(relatedScore);
      const isPositivePair =
        (winnerNet > 0 && relatedNet > 0 && winnerNet === relatedNet) ||
        (winnerNet === 1 && relatedNet > 0) ||
        (relatedNet === 1 && winnerNet > 0);
      const isNegativePair = winnerNet < 0 && relatedNet < 0;

      if (isPositivePair || isNegativePair) {
        dabaaqPair = {
          player1: winnerName,
          player2: relatedName,
          type: isPositivePair ? 'positive_positive' : 'negative_negative',
          amount: isNegativePair
            ? Math.min(Math.abs(winnerNet), Math.abs(relatedNet))
            : 2,
          createdFrom: {
            player1Net: winnerNet,
            player2Net: relatedNet,
          },
        };
        break;
      }
    }
  }

  /*
   * ==========================================================
   * 2. SCORE-KA CIYAARTA CUSUB
   *
   * Qofkii ciyaarta xira wuxuu helayaa +1.
   * ==========================================================
   */
  const winnerBefore = winnerScoreBefore;

  /*
   * Guusha ciyaarta:
   *
   * Haddii uu fooro leeyahay -> hal fooro ayaa dhab ahaan laga saaraa.
   * Haddii uusan fooro lahayn -> hal guul ayaa lagu daraa.
   *
   * Ha lagu shaqayn net-ka oo keliya. Tusaale ahaan:
   *   wins: 1, fooros: 1
   *
   * net-ku waa 0, laakiin fooradu weli way jirtaa. Guushu waa inay
   * marka hore ka saartaa foorada, sida uu xeerka ciyaartu qabo.
   */
  const winnerAfterScore = {
    wins: Number(winner.wins) || 0,
    fooros: Number(winner.fooros) || 0,
    displayName: winner.displayName || winnerName,
  };
  applyWinnerScore(winnerAfterScore);
  let winnerAfter = netOf(winnerAfterScore);

  /*
   * ==========================================================
   * 3. HADDII DABAAQ JIRO
   * ==========================================================
   */
  let dabaaqType = null;
  let positiveDabaaqApplied = false;

  if (dabaaqPair) {
    // API-ga dibadda wuxuu isticmaalaa magacyadan kooban; kaydka gudaha
    // wuxuu hayaa magaca faahfaahsan si aan pair hore u jabin.
    dabaaqType = dabaaqPair.type === 'positive_positive' ? 'positive' : 'negative';

    const otherName =
      normalizeSessionName(dabaaqPair.player1) === winnerKey
        ? dabaaqPair.player2
        : dabaaqPair.player1;

    const otherKey = normalizeSessionName(otherName);

    const otherScore = ensureSessionScore(scores, otherName);

    /*
     * ----------------------------------------------------------
     * POSITIVE DABAAQ
     *
     * Tusaale:
     *
     * Abshir   +4
     * Jimcaale +1
     *
     * Jimcaale ayaa xiray:
     *
     * Jimcaale: +1 bilow ah +1 ciyaarta +1 fooro = +3
     * Abshir: -1 Dabaaq = +3
     * ----------------------------------------------------------
     */
    if (dabaaqPair.type === 'positive_positive') {
       const otherBefore = netOf(otherScore);

        /*
         * Qofka +1 leh ayaa helaya +1 ciyaarta iyo +1 Dabaaq.
         * Qofka kale dhibicdiisa Dabaaqda ayaa laga jarayaa hal.
         * Sidaas darteed +1 -> 0; haddii uu +2 yahayna +2 -> +1.
        *
        * Tusaalaha saxda ah:
        *   Jimcaale +1 -> +3
        *   Abshir   +4 -> +3
        */
       if (winnerBefore > 0 && winnerBefore === otherBefore) {
         // Tusaale +2/+2: guuleystaha +2 (guul) +2 (Dabaaq) = +5,
         // qofka kale dhibcihiisa labada ahna waxaa loo celiyaa eber.
         winnerAfter = winnerBefore + otherBefore + 1;

         if (otherScore) {
           scores[otherKey] = {
             ...canonicalScore(0),
             fooroOwners: [],
             displayName: otherScore.displayName || otherName,
           };
         }

         positiveDabaaqApplied = true;
       } else if (winnerBefore === 1 && otherBefore >= 1) {
         winnerAfter = winnerBefore + 2;

         if (otherScore) {
             const otherAfter = Math.max(0, otherBefore - 1);
            scores[otherKey] = {
              ...canonicalScore(otherAfter),
              fooroOwners: fooroOwnersFor(otherScore).slice(
                0,
                 Math.max(0, -otherAfter)
              ),
             displayName: otherScore.displayName || otherName,
           };
         }

         positiveDabaaqApplied = true;
       } else {
         winnerAfter = winnerBefore + 1;
       }

      console.log('🟢 POSITIVE DABAAQ LA QAATAY:', {
        winner: winnerName,
        other: otherName,
        result: winnerAfter
      });
    }

    /*
     * ----------------------------------------------------------
     * NEGATIVE DABAAQ
     *
     * Tusaale:
     *
     * Faarax  -1
     * Jaamac  -1
     *
     * Ciyaarta cusub:
     * Faarax  0
     * Jaamac  0
     *
     * Midkii hore u xira wuxuu marka hore helayaa +1.
     *
     * Dabaaqdu tabane ma siin karto wax ka badan +1:
     * winner = +1
     * other  = -2
     *
     * Haddii fooradu ku dhacdo qofka kale, wuxuu noqonayaa -3.
     * ----------------------------------------------------------
     */
    else if (dabaaqPair.type === 'negative_negative') {
      /*
       * Ha ku tiirsanaan amount-ka snapshot-ka, sababtoo ah snapshot-ku
       * wuu duugoobi karaa haddii score-ku is beddelo ka hor xiritaanka.
       * Tusaale -4 iyo -1: hal Dabaaq oo keliya ayaa la kala wareejinayaa,
       * sidaas darteed qofka kale -1 -> -2 ayuu noqonayaa, ma aha -3.
       */
      const otherBefore = netOf(otherScore);
      const dabaaqAmount = Math.max(
        1,
        Math.min(Math.abs(winnerBefore), Math.abs(otherBefore))
      );

      // Negative Dabaaqdu waxay siin kartaa guuleystaha ugu badnaan +1.
      // Sidaas darteed -4 -> -2, -2 -> 0, -1 -> +1.
      winnerAfter = Math.min(1, winnerBefore + 2);

      if (otherScore) {
        scores[otherKey] = {
          wins: 0,
          fooros: (Number(otherScore.fooros) || 0) + dabaaqAmount,
          fooroOwners: fooroOwnersFor(otherScore).slice(0, (Number(otherScore.fooros) || 0) + dabaaqAmount),
          displayName:
            otherScore.displayName || otherName
        };
      }

      console.log('🔴 NEGATIVE DABAAQ LA QAATAY:', {
        winner: winnerName,
        other: otherName,
        winnerResult: winnerAfter,
        otherResult: -((Number(otherScore?.fooros) || 0) + dabaaqAmount),
        dabaaqAmount
      });
    }

    /*
     * Dabaaqdii hal mar ayay shaqaysay.
     * Ka saar pair-ka kaydka session-ka iyo snapshot-ka qolka.
     */
    const samePair = pair => {
      const a = normalizeSessionName(pair?.player1);
      const b = normalizeSessionName(pair?.player2);
      const x = normalizeSessionName(dabaaqPair?.player1);
      const y = normalizeSessionName(dabaaqPair?.player2);
      return (a === x && b === y) || (a === y && b === x);
    };
    room.dabaaqPairs = room.dabaaqPairs.filter(pair => !samePair(pair));
    if (Array.isArray(room.activeDabaaqPairs)) {
      room.activeDabaaqPairs = room.activeDabaaqPairs.filter(pair => !samePair(pair));
    }
  }

  /*
   * Hoosgale/Batuuto waa ciqaab gaar ah:
   * - haddii uu hayay +1 dabaaq, hal guul ayaa laga qaadayaa;
   * - foorada Hoosgale-ga waxaa lagu daraa marka xisaabta oo dhan
   *   (Dabaaq iyo qofka foorada qaadanaya) la hubiyo.
   *
   * Haddii hoosgaluhu yahay victimName, fooradii hoose ayaa hore loogu
   * dari doonaa dhammaadka, sidaas darteed halkan mar labaad laguma darayo.
   */
  if (hoosgalePlayer) {
    const hoosgaleScore = ensureSessionScore(scores, hoosgalePlayer.name);
    if (hoosgaleScore) {
      const isAlreadyFooroVictim =
        normalizeSessionName(victimName) === normalizeSessionName(hoosgalePlayer.name);

      /*
       * Haddii Hoosgale-ga yahay isla qofka Fooradu ku dhacday, Foorada
       * dhammaadka ayaa hore ugu filan hal ciqaab. Wins-- halkan lagu
       * daro waxay qofka ka jaraysaa laba dhibcood (hal win iyo hal
       * fooro), taas oo ahayd sababta Faarax +3 uga dhashay +1.
       *
       * Wins-- waxaa la hayaa oo keliya marka Hoosgale-gu yahay qof kale
       * oo aan ahayn victim-ka Foorada.
       */
      if (!isAlreadyFooroVictim && (Number(hoosgaleScore.wins) || 0) > 0) {
        hoosgaleScore.wins = Math.max(0, (Number(hoosgaleScore.wins) || 0) - 1);
      }
      console.log('🟣 HOOSGALE FOORO:', {
        player: hoosgalePlayer.name,
        result: netOf(hoosgaleScore),
        fooroTarget: victimName || null,
        fooroAlreadyPlanned: isAlreadyFooroVictim
      });
    }
  }

  /*
   * ==========================================================
   * 4. UGU DAMBAYN: wareeji ama baabi'i foorada
   * ==========================================================
   *
   * Halkan ayay fooradu ku dhacaysaa hal mar, kadib marka:
   *   1) Hoosgale la aqoonsaday,
   *   2) xaaladda guuleystaha la hubiyay,
   *   3) Dabaaqda la xisaabiyay.
   */
  if (victimKey && victimKey !== winnerKey) {
    const victim = ensureSessionScore(scores, victimName);
    if (victim) {
      /*
       * Kala saar qofka hadda foorada hayay iyo milkiilihii
       * foorada. Kaliya winner score ahaan taban yahay ayaa
       * fooradii hore la wareejinayaa; score 0 ama ka sarreeya
       * wuxuu abuuraa fooro cusub.
       */
      fooroWasTransferred = transfersExistingFooro;
      transferredFooroOwnerName =
        transfersExistingFooro
          ? winnerFooroOwners.shift() || winnerName
          : winnerName;

      /*
       * Haddii Fooradu ugu noqoto milkiilihii hore, weli waa Fooro cusub
       * oo ku dhacday qofkaas. Ha baabi'in. Tusaale ahaan Faarax -4 oo
       * Fooradiisii ugu soo noqota waa inuu noqdaa -5, si xilligu u
       * dhammaado marka target-ku yahay 5.
       */
      victim.fooros = (Number(victim.fooros) || 0) + 1;
      victim.fooroOwners = [
        ...fooroOwnersFor(victim),
        transferredFooroOwnerName
      ].slice(0, victim.fooros);
    }
  }

  /*
   * ==========================================================
   * 5. Ku qor winner-ka score-kiisa
   * ==========================================================
   */
  const winnerCanonical = canonicalScore(winnerAfter);
  winnerCanonical.fooroOwners = winnerFooroOwners.slice(
    0,
    winnerCanonical.fooros
  );

  const oldWinnerNet = netOf(winner);

  scores[winnerKey] = {
    wins: winnerCanonical.wins,
    fooros: winnerCanonical.fooros,
    fooroOwners: winnerCanonical.fooroOwners,
    displayName: winner.displayName || winnerName
  };

  const balanceFix = positiveDabaaqApplied
    ? null
    : rebalanceScoreMap(scores, winnerName);
  if (balanceFix) {
    console.log('⚖️ SESSION SCORE BALANCED:', balanceFix);
  }

  /*
   * Deltas-ka persistent profile-ka ka soo saar farqiga dhabta ah ee
   * session-ka. Tani waxay daboolaysaa winner-ka, qofka dabaaqda laga
   * qaaday iyo qofka provider-ka ah hal mar, iyada oo aan score hore
   * loo tirin laba jeer.
   */
  Object.keys(deltas).forEach(key => delete deltas[key]);
  const scoreKeys = new Set([
    ...Object.keys(beforeScores),
    ...Object.keys(scores),
  ]);
  scoreKeys.forEach(key => {
    const before = beforeScores[key] || {};
    const after = scores[key] || {};
    const winsDelta = (Number(after.wins) || 0) - (Number(before.wins) || 0);
    const foorosDelta = (Number(after.fooros) || 0) - (Number(before.fooros) || 0);
    const netDelta = (winsDelta - foorosDelta);
    if (winsDelta || foorosDelta || netDelta) {
      addScoreDelta(deltas, after.displayName || before.displayName || key, {
        wins: winsDelta,
        fooros: foorosDelta,
        net: netDelta,
      });
    }
  });

  /*
   * ==========================================================
   * 6. Session-ka ku celi
   * ==========================================================
   */
  season.scores = scores;
  room.sessionScores = season.scores;

  saveSessionsData();

  /*
   * UI-ga cusboonaysii
   */
  if (io && room.id) {
    io.to(room.id).emit('updateScores', {
      sessionScores: getRoomVisibleScores(room),
      xiiliTarget: target
    });
  }

  /*
   * Hubi season end
   */
  const visibleScores = getRoomVisibleScores(room);
  const loserEntry = Object.entries(room.sessionScores).find(
    ([, score]) =>
      (Number(score?.fooros) || 0) >= target
  );

  if (loserEntry && !season.ended) {
    const [loserKey] = loserEntry;

    season.ended = true;

    saveSessionsData();

    // Haddii qofka gaaray target-ku miis kale joogo, season-ka weli wuu
    // dhammaaday, laakiin magaciisa/score-kiisa looma dirayo miiskan.
    if (io && room.id && visibleScores[loserKey]) {
      io.to(room.id).emit('seasonEnded', {
        loser:
          visibleScores[loserKey]?.displayName ||
          loserKey,
        scores: visibleScores,
        target
      });
    }
  }

  return {
    scores: getRoomVisibleScores(room),
    deltas,
    dabaaqType,
    dabaaqPair: dabaaqPair
      ? {
          player1: dabaaqPair.player1,
          player2: dabaaqPair.player2,
          type: dabaaqPair.type,
          amount: dabaaqPair.amount || 2,
          player1Before: scoreSnapshot(dabaaqPair.player1, beforeScores),
          player2Before: scoreSnapshot(dabaaqPair.player2, beforeScores),
          player1After: scoreSnapshot(dabaaqPair.player1, scores),
          player2After: scoreSnapshot(dabaaqPair.player2, scores),
        }
      : null,
    fooroOwnerName: transferredFooroOwnerName,
    fooroTransferorName: fooroWasTransferred ? winnerName : null,
    fooroWasTransferred,
    fooroReturnedToOwnerName,
  };
}

function simulateAndApplyDabaaq(
  io,
  room,
  winnerName,
  dabaaqOwnerName,
  victimFooroName = null
) {
  return applyCorrectDabaaqScores(
    io,
    room,
    winnerName,
    dabaaqOwnerName,
    victimFooroName
  );

}


function applyDabaaq(
  io,
  room,
  winnerName,
  dabaaqOwnerName,
  victimFooroName = null
) {
  return simulateAndApplyDabaaq(
    io,
    room,
    winnerName,
    dabaaqOwnerName,
    victimFooroName
  );
}


function applyWinnerScore(winnerScore) {
  // Haddii qofku uu leeyahay foorooyin la duldhacay, guushu waxay ka gooynaysaa hal fooro (net-ka ayay saxaysaa)
  if (winnerScore.fooros > 0) {
    winnerScore.fooros--; // Ka jar hal fooro
  } else {
    winnerScore.wins = (winnerScore.wins || 0) + 1; // Haddii uusan fooro lahayn, u kordhi guul caadi ah
  }
}

function broadcastSessionScores(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  attachRoomToXiiliSession(room, room.xiiliTarget || 5);

  // Hubin in ciyaartoyda cusub ama la jooga ay diiwaanka ku jiraan
  room.players.forEach(p => {
    ensureSessionScore(room.sessionScores, p.name);
  });
  rebalanceScoreMap(room.sessionScores);

  io.to(roomId).emit('sessionFooroUpdate', {
    scores: getRoomVisibleScores(room),
    dabaaqPairs: Array.isArray(room.dabaaqPairs) ? room.dabaaqPairs : [],
    xiiliTarget: room.xiiliTarget || 5
  });
}

// ─── Hubinta xiilliga dhammaadka: haddii qof uu gaaro target ─────────────────
function checkAndEmitSeasonEnd(roomId) {
  const room = rooms[roomId];
  if (!room) return false;
  const target = room.xiiliTarget || 5;
  const visibleScores = getRoomVisibleScores(room);
  const loserEntry = Object.entries(room.sessionScores || {}).find(([, d]) => d.fooros >= target);
  if (loserEntry) {
    const [loserKey] = loserEntry;
    if (visibleScores[loserKey]) {
      io.to(roomId).emit('seasonEnded', {
        scores: visibleScores,
        loser: visibleScores[loserKey].displayName || loserKey,
        target,
      });
    }
    return true;
  }
  return false;
}

function resetXiiliSession(target = 5) {
  const normalizedTarget = normalizeXiiliTarget(target);
  const key = String(normalizedTarget);
  xiiliSessions.set(key, { target: normalizedTarget, scores: {}, ended: false });
  saveSessionsData();
}

// ─── Game Logic ───────────────────────────────────────────────────────────────
const TURN_TIME_LIMIT = 30000;
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;
const rooms = {};

function genToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getCardPoints(value) {
  if (['J', 'Q', 'K'].includes(value)) return 10;
  if (value === 'A') return 11;
  const p = parseInt(value);
  return isNaN(p) ? 0 : p;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createDeck() {
  const suits = ['♦', '♥', '♠', '♣'];
  const values = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (let i = 0; i < 4; i++)
    for (const s of suits)
      for (const v of values)
        deck.push({ suit: s, value: v, id: `${s}-${v}-${i}-${Math.random().toString(36).substr(2, 5)}`, points: getCardPoints(v) });
  return shuffle(deck);
}

function prepareGame() {
  const deck = createDeck();
  const allHands = [];
  for (let i = 0; i < 4; i++) allHands.push(deck.splice(0, i === 0 ? 15 : 14));
  return { allHands, remainingDeck: deck };
}

function getCardValue(card) {
  const map = { A: 14, K: 13, Q: 12, J: 11 };
  return map[card.value] ?? parseInt(card.value);
}

function isValidMeldSet(set) {
  if (!Array.isArray(set) || set.length < 3) return false;

  const cards = set.filter(Boolean);
  if (cards.length !== set.length) return false;

  // A run: every card has the same suit and consecutive values.
  const sameSuit = cards.every(card => card.suit === cards[0].suit);
  if (sameSuit) {
    const values = cards.map(getCardValue).sort((a, b) => a - b);
    return values.every((value, index) =>
      index === 0 || value === values[index - 1] + 1
    );
  }

  // A rank group: every card has the same value and a different suit.
  // There are only four suits, so a rank group can never exceed four cards.
  const sameValue = cards.every(card => card.value === cards[0].value);
  const suits = new Set(cards.map(card => card.suit));
  return sameValue && suits.size === cards.length && cards.length <= 4;
}

function autoSplitIntoGroups(cards) {
  const n = cards.length;
  if (!n) return [];

  const candidates = [];
  const addCandidate = (indices, kind) => {
    if (indices.length < 3) return;
    const mask = indices.reduce((value, index) => value | (1 << index), 0);
    if (!candidates.some(candidate => candidate.mask === mask)) {
      candidates.push({ indices: [...indices], mask, kind });
    }
  };

  const addRun = (suit, start, end) => {
    const choices = [];
    for (let value = start; value <= end; value++) {
      const matches = cards
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => card.suit === suit && getCardValue(card) === value)
        .map(({ index }) => index);
      if (!matches.length) return;
      choices.push(matches);
    }

    const visit = (at, picked) => {
      if (at === choices.length) {
        addCandidate(picked, 'run');
        return;
      }
      choices[at].forEach(index => visit(at + 1, [...picked, index]));
    };
    visit(0, []);
  };

  for (const suit of ['♠', '♥', '♣', '♦']) {
    for (let start = 6; start <= 12; start++) {
      for (let end = start + 2; end <= 14; end++) addRun(suit, start, end);
    }
  }

  for (const value of [...new Set(cards.map(card => card.value))]) {
    const bySuit = new Map();
    cards.forEach((card, index) => {
      if (card.value !== value) return;
      const list = bySuit.get(card.suit) || [];
      list.push(index);
      bySuit.set(card.suit, list);
    });
    const suits = [...bySuit.keys()];
    const addRankChoices = (selectedSuits, at = 0, picked = []) => {
      if (at === selectedSuits.length) {
        addCandidate(picked, 'rank');
        return;
      }
      (bySuit.get(selectedSuits[at]) || []).forEach(index => {
        addRankChoices(selectedSuits, at + 1, [...picked, index]);
      });
    };
    const chooseSuits = (at, picked) => {
      if (picked.length >= 3) addRankChoices(picked);
      if (picked.length === 4) return;
      for (let i = at; i < suits.length; i++) {
        chooseSuits(i + 1, [...picked, suits[i]]);
      }
    };
    chooseSuits(0, []);
  }

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

    let best = solve(usedMask | (1 << firstUnused));
    candidatesByIndex[firstUnused].forEach(candidate => {
      if (candidate.mask & usedMask) return;
      const rest = solve(usedMask | candidate.mask);
      best = better({
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
      }, best);
    });
    memo.set(usedMask, best);
    return best;
  };

  return solve(0).groups;
}

function findPairs(cards) {
  const pairs = [];
  const used = new Set();

  const byValue = {};
  for (const c of cards) (byValue[c.value] ??= []).push(c);
  for (const val in byValue) {
    const seenSuits = new Set();
    const grp = [];
    for (const c of byValue[val]) {
      if (!seenSuits.has(c.suit)) { seenSuits.add(c.suit); grp.push(c); }
    }
    if (grp.length === 2) { pairs.push(grp); grp.forEach(c => used.add(c.id)); }
  }

  for (const suit of ['♠', '♥', '♣', '♦']) {
    const sc = cards.filter(c => c.suit === suit && !used.has(c.id))
      .sort((a, b) => getCardValue(a) - getCardValue(b));
    for (let i = 0; i < sc.length - 1; i++) {
      if (used.has(sc[i].id) || used.has(sc[i + 1].id)) continue;
      if (getCardValue(sc[i + 1]) === getCardValue(sc[i]) + 1) {
        pairs.push([sc[i], sc[i + 1]]);
        used.add(sc[i].id); used.add(sc[i + 1].id);
      }
    }
  }
  return pairs;
}

function pickBestDiscard(hand, isSafe) {
  const groups = autoSplitIntoGroups([...hand]);
  const groupedIds = new Set(groups.flat().map(c => c.id));
  const rest = hand.filter(c => !groupedIds.has(c.id));
  const pairs = findPairs(rest);
  const pairedIds = new Set(pairs.flat().map(c => c.id));

  const singles = rest.filter(c => !pairedIds.has(c.id) && isSafe(c));
  if (singles.length > 0) return singles.sort((a, b) => getCardPoints(b.value) - getCardPoints(a.value))[0];

  const safePairs = pairs.filter(p => p.some(isSafe));
  if (safePairs.length > 0) {
    safePairs.sort((a, b) =>
      a.reduce((s, c) => s + getCardPoints(c.value), 0) - b.reduce((s, c) => s + getCardPoints(c.value), 0));
    return safePairs[0].filter(isSafe).sort((a, b) => getCardPoints(b.value) - getCardPoints(a.value))[0];
  }

  const safeGroups = groups.filter(g => g.some(isSafe));
  if (safeGroups.length > 0) {
    safeGroups.sort((a, b) => a.length - b.length);
    return safeGroups[0].filter(isSafe).sort((a, b) => getCardPoints(b.value) - getCardPoints(a.value))[0];
  }

  return hand.find(isSafe) || null;
}

function chooseBotDiscard(hand, room, bot) {
  if (!hand.length) return null;
  const nextPlayer = room && bot ? room.players[(room.activePlayerIndex + 1) % room.players.length] : null;
  const meelGaleActive = !!(room && bot && !bot.isOpened && hand.length > 1 && nextPlayer && nextPlayer.isOpened);
  const allTableSets = meelGaleActive ? room.players.flatMap(pl => pl.openedSets || []) : [];
  const isSafe = c => !meelGaleActive || !isCardMeelGale(c, allTableSets);
  return pickBestDiscard(hand, isSafe) || hand[hand.length - 1];
}

function checkBatuuta(room, p) {
  if (!p || !p.isOpened || p.hoosgale) return false;
  // Foorada ugu horreysa ma abuuri karto Hoosgale/Batuuto.
  if (!sessionHasPreviousFooro(room)) return false;
  if (!p.hand || p.hand.length !== 2) return false;
  const openedCount = (p.openedSets || []).reduce((s, set) => s + set.length, 0);
  if (openedCount < 12) return false;

  room.stockPile = shuffle([...room.stockPile, ...p.hand]);
  p.hand = [];
  p.isOpened = false;
  p.openedSets = [];
  p.hoosgale = true;
  room.batuutaSequence = (Number(room.batuutaSequence) || 0) + 1;
  p.hoosgaleOrder = room.batuutaSequence;

  // Haddii qofkii ugu horreeyay ee ka gudbiyay 101 uu Batuuto noqdo,
  // furitaankiisii sharci ahaan wuu baaba'ay. Qofka xiga wuxuu ku
  // bilaabayaa xeerkii hore ee 101, ee ma aha 130 + 1.
  if (room.firstOpenerId === p.id) {
    room.hasFirstOpened = false;
    room.firstOpenerId = null;
    room.firstOpenerOriginalPoints = null;
    room.lastOpenPoints = 101;
    room.barrierFrozen = false;
    room.barrierHistory = [101];
  }

  return true;
}

function allBatuutoWinner(room) {
  if (!room || !Array.isArray(room.players)) return null;

  const batuutoPlayers = room.players.filter(player => player && player.hoosgale);
  const remainingPlayers = room.players.filter(player => player && !player.hoosgale);

  // Ciyaartu waxay leedahay 4 ciyaaryahan. Marka saddex ay Batuuto
  // noqdaan, qofka afraad ee soo haray ayaa si toos ah u guuleysta.
  if (batuutoPlayers.length >= 3 && remainingPlayers.length === 1) {
    return remainingPlayers[0];
  }

  return null;
}

function finishIfAllBatuuto(roomId) {
  const room = rooms[roomId];
  const winner = allBatuutoWinner(room);
  if (!room || !winner || room.historyRecorded) return false;

  const firstBatuutoPlayer = firstBatuuto(room.players, winner.id);
  io.to(roomId).emit(
    'notification',
    `🏆 ${winner.name} ayaa si toos ah u guuleystay — saddex ciyaaryahan ayaa BATUUTO noqday! ` +
    `Fooradana waxaa lagu saaray ${firstBatuutoPlayer?.name || 'qofkii ugu horreeyay ee BATUUTO galay'}.`
  );

  endGame(roomId, winner, {
    actionType: 'all-batuuto',
    allBatuuto: true,
  });
  return true;
}

function handleBatuutaAfterDiscard(roomId, p) {
  const room = rooms[roomId];
  if (!room || !p || !checkBatuuta(room, p)) return false;

  io.to(roomId).emit(
    'notification',
    `🚨 ${p.name} wuxuu degay 12+ kaar, 2-na wuu hayay — waa BATUUTO! Kaararkii dib ayaa loo celiyay.`
  );
  io.to(p.id).emit('hoosgaleTriggered');
  updateRoomPlayers(roomId);
  broadcastTableUI(roomId);
  if (finishIfAllBatuuto(roomId)) return true;
  moveToNextPlayer(roomId);
  return true;
}

function isCardMeelGale(card, openedSets) {
  if (!openedSets || !openedSets.length) return false;
  for (const set of openedSets) {
    if (!set || !set.length) continue;
    if (set.every(c => c.suit === card.suit)) {
      const vals = set.map(c => getCardValue(c)).sort((a, b) => a - b);
      const v = getCardValue(card);
      if (v === vals[0] - 1 || v === vals[vals.length - 1] + 1) return true;
    }
    if (set.every(c => c.value === card.value) && !set.some(c => c.suit === card.suit) && set.length < 4) return true;
  }
  return false;
}

function pickAutoDiscard(room, cur) {
  const hand = cur.hand;
  if (!hand || !hand.length) return null;

  const nextIdx = (room.activePlayerIndex + 1) % room.players.length;
  const nextPlayer = room.players[nextIdx];
  const meelGaleActive = !cur.isOpened && hand.length > 1 && nextPlayer && nextPlayer.isOpened;
  const allTableSets = meelGaleActive ? room.players.flatMap(pl => pl.openedSets || []) : [];
  const isSafe = c => !meelGaleActive || !isCardMeelGale(c, allTableSets);

  const takeById = id => {
    const idx = hand.findIndex(c => c.id === id);
    return idx !== -1 ? hand.splice(idx, 1)[0] : null;
  };

  if (cur.pickedFromDiscard && cur.lastPickedCardId) {
    // Kaarka tuurka la qaatay lama tuuri karo; waa in lagu daraa koox.
    return null;
  }

  const best = pickBestDiscard(hand, isSafe);
  if (best) return takeById(best.id);

  return hand.pop();
}

function returnPickedDiscard(room, player) {
  if (!player?.pickedFromDiscard || !player.lastPickedCardId) return false;
  const cardIdx = player.hand.findIndex(card => card.id === player.lastPickedCardId);
  if (cardIdx === -1) return false;

  const card = player.hand.splice(cardIdx, 1)[0];
  room.discardPile.push(card);
  player.hasActioned = false;
  player.pickedFromDiscard = false;
  player.lastPickedCardId = null;
  player.dabaaqProviderId = null;
  return card;
}

function getPlayerOpenedPoints(player) {
  return (player.openedSets || []).flat().reduce((s, c) => s + getCardPoints(c.value), 0);
}

function recalculateRoomBarrier(room) {
  if (!room.barrierHistory) room.barrierHistory = [101];
  if (!room.hasFirstOpened) { room.lastOpenPoints = 101; return; }
  if (room.barrierFrozen) return;
  const oldBarrier = room.lastOpenPoints;
  const otherOpened = room.players.some(p => p.isOpened && p.id !== room.firstOpenerId);
  if (otherOpened) {
    room.lastOpenPoints = (room.firstOpenerOriginalPoints ?? 101) + 1;
    room.barrierFrozen = true;
  } else {
    const firstOpener = room.players.find(p => p.id === room.firstOpenerId);
    if (firstOpener) room.lastOpenPoints = getPlayerOpenedPoints(firstOpener) + 1;
  }
  if (room.barrierHistory.length === 1 && room.lastOpenPoints !== oldBarrier) {
    const openerScore = room.firstOpenerOriginalPoints ?? (room.lastOpenPoints - 1);
    room.barrierHistory.push(openerScore, room.lastOpenPoints);
  } else if (room.barrierHistory.length > 1) {
    room.barrierHistory[room.barrierHistory.length - 1] = room.lastOpenPoints;
  }
}

// Xadka furitaanka waa mid guud oo ciyaarta ah:
// 101 bilowga, kadibna hal dhibic ka sarreeya furitaankii ugu dambeeyay
// ilaa ciyaaryahan kale dhexda ka furo. Markaas xadka wuu xasilloonaanayaa
// oo ku noqdaa furitaankii ciyaaryahankii ugu horreeyay + 1.
function getOpeningMinimum(room) {
  return room?.hasFirstOpened ? room.lastOpenPoints : 101;
}

function cardIsInGroups(groups, cardId) {
  return Array.isArray(groups) &&
    groups.some(group => Array.isArray(group) && group.some(card => card?.id === cardId));
}

function cardFitsAnyOpenedSet(room, card) {
  return room.players.some(player =>
    (player.openedSets || []).some(set => isCardMeelGale(card, [set]))
  );
}

function resetPlayerState(p) {
  p.hand = []; p.isOpened = false; p.hasActioned = false;
  p.pickedFromDiscard = false; p.lastPickedCardId = null;
  p.openedSets = []; p.hoosgale = false; p.hoosgaleOrder = null; p.tempScore = 0;
  p.openedWithCardId = null; p.openProviderId = null;
  p.dabaaqProviderId = null;
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new IOServer(httpServer, {
  path: '/game-io',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
});

function updateRoomPlayers(roomId) {
  const room = rooms[roomId]; if (!room) return;
  const active = room.players[room.activePlayerIndex];
  io.to(roomId).emit('playersUpdate', {
    players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, isOpened: p.isOpened, online: p.online, points: p.points, isBot: p.isBot, hoosgale: p.hoosgale })),
    stockCount: room.stockPile.length,
    currentTurnId: active ? active.id : null,
    turnStartTime: room.turnStartTime,
    nextRequiredPoints: getOpeningMinimum(room),
    barrierHistory: room.barrierHistory || [101],
  });
}

function broadcastTableUI(roomId) {
  const room = rooms[roomId]; if (!room) return;
  io.to(roomId).emit('updateTableUI', {
    discardPile: room.discardPile,
    players: room.players.map(p => ({ id: p.id, name: p.name, openedSets: p.openedSets })),
    nextRequiredPoints: room.lastOpenPoints || 101
  });
}

function endGame(roomId, potentialWinner, extraData = {}) {
  const room = rooms[roomId];
  if (!room) return;

  const isAllBatuutoFinish = extraData.allBatuuto === true;
  if (!potentialWinner || (!potentialWinner.isOpened && !isAllBatuutoFinish) || room.historyRecorded) return;
  room.historyRecorded = true;

  if (room.turnTimeout) clearTimeout(room.turnTimeout);

  room.players.forEach(pl => {
    if (pl.id === potentialWinner.id) return;
    if (!pl.isOpened && !pl.hoosgale) { pl.points += 101; }
    if (pl.isOpened && pl.hoosgale) { pl.points += 1; }
  });

  // 1. SESSION & DABAQA SCORES CALCULATION
  initializeRoomScores(room, room.xiiliTarget || 5);
  // Haddii room-ku hore u bilaabmay oo snapshot-kii active-ku duugoobay,
  // ku dar pair-yada hadda la helay si Dabaaqdu u saameyso ciyaartan.
  room.activeDabaaqPairs = Array.isArray(room.dabaaqPairs)
    ? room.dabaaqPairs.map(pair => ({ ...pair }))
    : [];
  // Pair-ka waa in la ogaadaa ka hor inta aan natiijada ciyaartan lagu
  // darin score-ka session-ka. Tani waxay sidoo kale soo kabanaysaa
  // ciyaar hore u bilaabatay ka hor patch-ka Dabaaqda.
  room.gameStarted = false;

  const dabaaqProviderId = potentialWinner.dabaaqProviderId || potentialWinner.openProviderId || null;
  const fooroTargetId = findFooroTarget(potentialWinner.id, dabaaqProviderId, room.players);
  const winnerPlayer = room.players.find(p => p.id === potentialWinner.id);
  const victimPlayer = fooroTargetId ? room.players.find(p => p.id === fooroTargetId) : null;
  const providerPlayer = dabaaqProviderId && dabaaqProviderId !== potentialWinner.id
    ? room.players.find(p => p.id === dabaaqProviderId)
    : null;
  const hoosgalePlayer = firstBatuuto(room.players, potentialWinner.id);
  
  const scoreResult = winnerPlayer
    ? applyCorrectDabaaqScores(io, room, winnerPlayer.name, providerPlayer?.name || null, victimPlayer?.name || null)
    : { scores: room.sessionScores, deltas: {}, dabaaqType: null };

  /*
   * Score-ka hadda la dhammeeyay ha noqdo isha live-ka ee Dabaaqda
   * ciyaarta xigta. Haddii aan halkan dib loo dhisin, sessionFooroUpdate
   * wuxuu diri lahaa pair-kii lagu sameeyay score-yadii ciyaartii hore.
   */
  const updatedSeason = getXiiliSession(room.xiiliTarget || 5);
  rebuildDabaaqPairsFromScores(room, updatedSeason);
  room.activeDabaaqPairs = room.dabaaqPairs.map(pair => ({ ...pair }));
  saveSessionsData();

  const fooroOwnerPlayer = scoreResult.fooroOwnerName
    ? room.players.find(
        p => normalizeSessionName(p.name) === normalizeSessionName(scoreResult.fooroOwnerName)
      )
    : null;

  // ⚡ 2. SI DEGDEG AH U KEYDI OO U BAAHIN DHIBCAHA (IMMEDIATE UPDATE & BROADCAST)
  // Halkan ayaan keenney si aysan u sugin inta gameOver event-ka la diyaarinayo
  const { roundDeltas, updatedProfiles } = updatePersistentScores(room, scoreResult);
  broadcastSessionScores(roomId);
  if (updatedProfiles.length) {
    io.to(roomId).emit('profileScoresUpdate', { profiles: updatedProfiles });
  }

  const gameOverExplanation = explainGameOver({
    winnerName: potentialWinner.name,
    actionType: extraData.actionType || 'discard',
    allBatuuto: isAllBatuutoFinish,
    fooroTargetName: victimPlayer?.name || null,
    fooroOwnerName: scoreResult.fooroOwnerName || null,
    fooroTransferorName: scoreResult.fooroTransferorName || null,
    fooroWasTransferred: scoreResult.fooroWasTransferred === true,
    fooroReturnedToOwnerName: scoreResult.fooroReturnedToOwnerName || null,
    hoosgaleName: hoosgalePlayer?.name || null,
    dabaaqType: scoreResult.dabaaqType || null,
    dabaaqPair: scoreResult.dabaaqPair || null,
    roundDeltas,
    players: room.players.map(player => ({
      name: player.name,
      score: room.sessionScores?.[normalizeSessionName(player.name)] || null,
    })),
  });

  const historyRecord = winnerHistory.recordGame({
    winnerName: potentialWinner.name,
    winnerId: potentialWinner.id,
    roomId,
    xiiliTarget: room.xiiliTarget || 5,
    players: room.players.map(player => ({
      name: player.name,
      isBot: player.isBot,
    })),
  });
  io.emit('winnerHistoryUpdate', winnerHistory.getSummary());

  // Reset-ka profile-ka haddii xiiligu dhammaaday
  if (getXiiliSession(room.xiiliTarget || 5).ended) {
    resetAllProfileStats();
    io.emit('profilesReset');
  }

  // 3. EMIT GAME OVER & LEADERBOARD DATA
  io.to(roomId).emit('gameOver', {
    winnerId: potentialWinner.id,
    winnerName: potentialWinner.name,
    fooroTargetId,
    fooroOwnerId: fooroOwnerPlayer?.id || null,
    fooroOwnerName: fooroOwnerPlayer?.name || null,
    fooroTransferorName: scoreResult.fooroTransferorName || null,
    fooroWasTransferred: scoreResult.fooroWasTransferred === true,
    fooroReturnedToOwnerName: scoreResult.fooroReturnedToOwnerName || null,
    hoosgaleId: hoosgalePlayer?.id || null,
    hoosgaleName: hoosgalePlayer?.name || null,
    dabaaqType: scoreResult.dabaaqType || null,
    dabaaqPair: scoreResult.dabaaqPair || null,
    sessionScores: getRoomVisibleScores(room),
    xiiliTarget: room.xiiliTarget || 5,
    providerId: dabaaqProviderId,
    actionType: extraData.actionType || 'discard',
    allBatuuto: isAllBatuutoFinish,
    gameOverExplanation,
    lastCard: extraData.lastCard || null,
    historyRecord,
    stats: room.playerStats || {},
    history: room.moveHistory || [],
    allPlayers: room.players.map(pl => ({
      id: pl.id,
      name: pl.name,
      isOpened: pl.isOpened,
      hand: pl.hand,
      points: pl.points,
      isBot: pl.isBot,
      openedSets: pl.openedSets,
      hoosgale: !!pl.hoosgale,
      openProviderId: pl.openProviderId || null
    })),
  });

  const leaderboard = getLeaderboardData();
  if (leaderboard.length > 0) {
    io.to(roomId).emit('leaderboardUpdate', { leaderboard, roundDeltas, fooroTargetId });
  }

  // Hubi haddii xilliyagu dhammaadey
  checkAndEmitSeasonEnd(roomId);

  room.cleanupTimer = setTimeout(() => {
    room.cleanupTimer = null;
    const currentRoom = rooms[roomId];
    // Haddii forceResetGame ay ciyaar cusub bilowday, qolka ha tirtirin.
    if (currentRoom === room && !currentRoom.gameStarted) {
      io.in(roomId).socketsLeave(roomId);
      delete rooms[roomId];
    }
  }, 8000);
}

function moveToNextPlayer(roomId) {
  const room = rooms[roomId]; if (!room) return;
  room.isPaused = false;
  room.turnToken = (room.turnToken || 0) + 1;
  if (room.turnTimeout) { clearTimeout(room.turnTimeout); room.turnTimeout = null; }
  room.activePlayerIndex = (room.activePlayerIndex + 1) % room.players.length;
  let safety = 0;
  while (safety < room.players.length) {
    const cur = room.players[room.activePlayerIndex];
    if (cur && (cur.online || cur.isBot) && !cur.hoosgale) break;
    room.activePlayerIndex = (room.activePlayerIndex + 1) % room.players.length;
    safety++;
  }
  const next = room.players[room.activePlayerIndex];
  room.players.forEach(p => { p.hasActioned = false; p.pickedFromDiscard = false; p.lastPickedCardId = null; });
  startTurnTimer(roomId);
  if (next && !next.isBot) io.to(next.id).emit('yourTurn');
}

function scheduleBotTurn(roomId, botId) {
  const room = rooms[roomId]; if (!room || !room.gameStarted) return;
  const thinkTime = 1200 + Math.floor(Math.random() * 800);
  const myToken = room.turnToken;
  room.turnTimeout = setTimeout(() => {
    if (!rooms[roomId] || rooms[roomId].turnToken !== myToken) return;
    doBotTurn(roomId, botId);
  }, thinkTime);
}

function refillStockIfEmpty(roomId) {
  const room = rooms[roomId]; if (!room) return;
  if (room.stockPile.length === 0 && room.discardPile.length > 1) {
    const top = room.discardPile.pop();
    room.stockPile = shuffle([...room.discardPile]);
    room.discardPile = [top];
    io.to(roomId).emit('updateStockCount', room.stockPile.length);
  }
}

function doBotTurn(roomId, botId) {
  const room = rooms[roomId]; if (!room || !room.gameStarted) return;
  const botIdx = room.players.findIndex(p => p.id === botId);
  if (botIdx === -1 || botIdx !== room.activePlayerIndex) return;
  const bot = room.players[botIdx];
  if (!bot || !bot.isBot) return;

  refillStockIfEmpty(roomId);
  let drewFromDiscard = false;

  if (room.discardPile.length > 0 && !bot.isOpened) {
    const topDiscard = room.discardPile[room.discardPile.length - 1];
    const testGroups = autoSplitIntoGroups([...bot.hand, topDiscard]);
    const testScore = testGroups.flat().reduce((s, c) => s + getCardPoints(c.value), 0);
    const canUseDiscardToOpen =
      cardIsInGroups(testGroups, topDiscard.id) &&
      testGroups.some(group => group.length >= 4);
    if (testScore >= getOpeningMinimum(room) && canUseDiscardToOpen) {
      room.discardPile.pop();
      const newCard = { ...topDiscard, fromDiscard: true };
      bot.hand.push(newCard);
      bot.hasActioned = true; bot.pickedFromDiscard = true; bot.lastPickedCardId = newCard.id;
      bot.dabaaqProviderId = room.lastProviderId || null;
      io.to(roomId).emit('updateDiscardPile', room.discardPile[room.discardPile.length - 1] ?? null);
      io.to(roomId).emit('botPickedDiscard', { botName: bot.name });
      drewFromDiscard = true;
    }
  }

  if (!drewFromDiscard && room.stockPile.length > 0) {
    const card = room.stockPile.pop();
    bot.hand.push(card); bot.hasActioned = true; bot.pickedFromDiscard = false; bot.lastPickedCardId = null;
    io.to(roomId).emit('updateStockCount', room.stockPile.length);
  }
  updateRoomPlayers(roomId);

  setTimeout(() => {
    if (!room.gameStarted) return;
    const groups = autoSplitIntoGroups([...bot.hand]);
    const totalScore = groups.flat().reduce((s, c) => s + getCardPoints(c.value), 0);
    const hasFourPlus = groups.some(g => g.length >= 4);

    if (!bot.isOpened) {
      const pickedDiscardMustBeUsed =
        bot.pickedFromDiscard && bot.lastPickedCardId
          ? cardIsInGroups(groups, bot.lastPickedCardId)
          : true;
      if (totalScore >= getOpeningMinimum(room) && hasFourPlus && pickedDiscardMustBeUsed) {
        const ids = new Set(groups.flat().map(c => c.id));
        bot.hand = bot.hand.filter(c => !ids.has(c.id));
        if (bot.pickedFromDiscard) bot.openProviderId = bot.dabaaqProviderId || null;
        bot.pickedFromDiscard = false;
        bot.lastPickedCardId = null;
        bot.isOpened = true; bot.openedSets.push(...groups);
        if (!room.hasFirstOpened) {
          room.hasFirstOpened = true; room.firstOpenerId = bot.id;
          room.firstOpenerOriginalPoints = getPlayerOpenedPoints(bot);
          if (!room.openedPlayerIds) room.openedPlayerIds = new Set();
          room.openedPlayerIds.add(bot.id);
        }
        const oldBarrier = room.lastOpenPoints;
        recalculateRoomBarrier(room);
        broadcastTableUI(roomId); updateRoomPlayers(roomId);
        io.to(roomId).emit('notification', room.lastOpenPoints !== oldBarrier
          ? `🤖 ${bot.name} ayaa furay! Minimum-ka dadka kale waa: ${room.lastOpenPoints}`
          : `🤖 ${bot.name} ayaa furay!`);

        let mgDone = false;
        bot.hand = bot.hand.filter(card => {
          for (const pl of room.players) {
            for (const set of (pl.openedSets || [])) {
              if (isCardMeelGale(card, [set])) { set.push(card); mgDone = true; return false; }
            }
          }
          return true;
        });
        if (mgDone) { recalculateRoomBarrier(room); broadcastTableUI(roomId); updateRoomPlayers(roomId); }
      } else if (bot.pickedFromDiscard && bot.lastPickedCardId) {
        // Haddii robot-ku uusan ku furmi karin kaarka tuurka, ma hayn karo
        // kaarka mana tuuri karo kaar kale. Tuurka dib ugu celi oo doorka gudub.
        const returnedCard = returnPickedDiscard(room, bot);
        if (returnedCard) {
          io.to(roomId).emit('updateDiscardPile', returnedCard);
          io.to(roomId).emit('botDiscardReturned', { botName: bot.name });
          updateRoomPlayers(roomId);
        }
        moveToNextPlayer(roomId);
        return;
      }
    } else if (
      bot.pickedFromDiscard &&
      bot.lastPickedCardId &&
      !cardIsInGroups(groups, bot.lastPickedCardId)
    ) {
      // Robot-ku ma dhamayn karo doorka isagoo kaarka tuurka iska haysta
      // ama mid kale tuuraya; haddii uusan gelin koox, dib ha ugu celiyo tuurka.
      const returnedCard = returnPickedDiscard(room, bot);
      if (returnedCard) {
        io.to(roomId).emit('updateDiscardPile', returnedCard);
        io.to(roomId).emit('botDiscardReturned', { botName: bot.name });
        updateRoomPlayers(roomId);
      }
      moveToNextPlayer(roomId);
      return;
    } else {
      if (groups.length > 0) {
        const ids = new Set(groups.flat().map(c => c.id));
        bot.hand = bot.hand.filter(c => !ids.has(c.id));
        if (bot.pickedFromDiscard && ids.has(bot.lastPickedCardId)) {
          bot.pickedFromDiscard = false;
          bot.lastPickedCardId = null;
        }
        bot.openedSets.push(...groups);
        const oldBarrier = room.lastOpenPoints;
        recalculateRoomBarrier(room);
        broadcastTableUI(roomId); updateRoomPlayers(roomId);
        if (room.lastOpenPoints !== oldBarrier)
          io.to(roomId).emit('notification', `🤖 ${bot.name} ayaa kordhiyay dhibcihiisii! Minimum-ka cusub waa: ${room.lastOpenPoints}`);
      }
      let mgDone = false;
      bot.hand = bot.hand.filter(card => {
        for (const pl of room.players) {
          for (const set of (pl.openedSets || [])) {
            if (isCardMeelGale(card, [set])) { set.push(card); mgDone = true; return false; }
          }
        }
        return true;
      });
      if (mgDone) { recalculateRoomBarrier(room); broadcastTableUI(roomId); updateRoomPlayers(roomId); }
    }

    setTimeout(() => {
      if (!room.gameStarted) return;
      if (bot.hand.length === 0) { endGame(roomId, bot); return; }

      const cardToDiscard = chooseBotDiscard(bot.hand, room, bot);
      if (!cardToDiscard) { moveToNextPlayer(roomId); return; }

      const di = bot.hand.findIndex(c => c.id === cardToDiscard.id);
      if (di !== -1) bot.hand.splice(di, 1);

      room.discardPile.push(cardToDiscard);
      io.to(roomId).emit('updateDiscardPile', cardToDiscard);

      if (bot.hand.length === 0) { updateRoomPlayers(roomId); endGame(roomId, bot); return; }

      room.lastProviderId = bot.id;

      if (handleBatuutaAfterDiscard(roomId, bot)) return;
      moveToNextPlayer(roomId);
    }, 700);
  }, 500);
}

function startTurnTimer(roomId) {
  const room = rooms[roomId]; if (!room) return;
  if (room.turnTimeout) { clearTimeout(room.turnTimeout); room.turnTimeout = null; }
  room.turnStartTime = Date.now(); room.isPaused = false;
  const player = room.players[room.activePlayerIndex];
  if (player && !player.isBot) room.turnToken = (room.turnToken || 0) + 1;
  const myToken = room.turnToken;
  updateRoomPlayers(roomId);
  if (!player) return;
  player.hasActioned = player.hand.length >= 15;
  if (player.isBot) { scheduleBotTurn(roomId, player.id); return; }

  room.turnTimeout = setTimeout(() => {
    if (!rooms[roomId] || rooms[roomId].turnToken !== myToken) return;
    if (!room.gameStarted || room.isPaused) return;
    const cur = room.players[room.activePlayerIndex];
    if (!cur || cur.id !== player.id) return;

     if (cur.isOpened) {
       if (cur.pickedFromDiscard && cur.lastPickedCardId) {
         const returnedCard = returnPickedDiscard(room, cur);
         if (returnedCard) {
           io.to(roomId).emit('updateDiscardPile', returnedCard);
           io.to(roomId).emit('discardReturnedByTimeout', {
             playerId: cur.id,
             card: returnedCard,
           });
           updateRoomPlayers(roomId);
           moveToNextPlayer(roomId);
           return;
         }
       }
      if (cur.hand.length > 0) {
        if (!cur.hasActioned) {
          refillStockIfEmpty(roomId);
          if (room.stockPile.length > 0) {
            const drawn = room.stockPile.pop();
            cur.hand.push(drawn);
            io.to(roomId).emit('updateStockCount', room.stockPile.length);
          } else { io.to(cur.id).emit('notification', 'Waqtigii wuu dhammaatay — Kaar la heli waayay, wareegga la gudbay.'); moveToNextPlayer(roomId); return; }
        }
        let cardToDiscard;
        if (cur.pickedFromDiscard && cur.lastPickedCardId) {
          const idx = cur.hand.findIndex(c => c.id === cur.lastPickedCardId);
          cardToDiscard = idx !== -1 ? cur.hand.splice(idx, 1)[0] : cur.hand.pop();
        } else { cardToDiscard = cur.hand.pop(); }
        if (cardToDiscard) {
          room.discardPile.push(cardToDiscard); room.lastProviderId = cur.id;
          io.to(roomId).emit('updateDiscardPile', cardToDiscard);
          io.to(cur.id).emit('autoDiscarded', { playerId: cur.id, card: cardToDiscard });
          io.to(cur.id).emit('updateHand', { hand: cur.hand });
        }
      }
      if (cur.hand.length === 0) { endGame(roomId, cur); return; }
       if (cardToDiscard && handleBatuutaAfterDiscard(roomId, cur)) return;
      moveToNextPlayer(roomId); return;
    }

     if (cur.hasActioned) {
       if (cur.pickedFromDiscard && cur.lastPickedCardId) {
         const returnedCard = returnPickedDiscard(room, cur);
         if (returnedCard) {
           io.to(roomId).emit('updateDiscardPile', returnedCard);
           io.to(roomId).emit('discardReturnedByTimeout', {
             playerId: cur.id,
             card: returnedCard,
           });
           updateRoomPlayers(roomId);
           moveToNextPlayer(roomId);
           return;
         }
       }
      const cardToDiscard = pickAutoDiscard(room, cur);
      if (cardToDiscard) {
        room.discardPile.push(cardToDiscard);
         room.lastProviderId = cur.id;
        io.to(roomId).emit('updateDiscardPile', cardToDiscard);
        io.to(cur.id).emit('autoDiscarded', { playerId: cur.id, card: cardToDiscard });
        io.to(cur.id).emit('updateHand', { hand: cur.hand });
         if (handleBatuutaAfterDiscard(roomId, cur)) return;
      }
      moveToNextPlayer(roomId); return;
    }

    refillStockIfEmpty(roomId);
    if (room.stockPile.length > 0) {
      const drawnCard = room.stockPile.pop();
      cur.hand.push(drawnCard);
      io.to(cur.id).emit('receiveCard', drawnCard);
      io.to(roomId).emit('updateStockCount', room.stockPile.length);
      cur.hand.pop();
      room.discardPile.push(drawnCard);
      io.to(roomId).emit('updateDiscardPile', drawnCard);
      io.to(cur.id).emit('autoDiscarded', { playerId: cur.id, card: drawnCard });
      io.to(cur.id).emit('updateHand', { hand: cur.hand });
    }
    moveToNextPlayer(roomId);
  }, TURN_TIME_LIMIT);
}

function startGame(roomId) {
  const room = rooms[roomId];

  if (!room || room.gameStarted) return;

  // Timer-kii nadiifinta ciyaartii hore yuusan tirtirin qolka
  // kadib marka ciyaarta cusub la bilaabo.
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  room.gameStarted = true;
  room.turnStartTime = Date.now();

  room.lastOpenPoints = 101;
  room.hasFirstOpened = false;
  room.firstOpenerId = null;
  room.firstOpenerOriginalPoints = null;
  room.barrierFrozen = false;
  room.openedPlayerIds = new Set();
  room.barrierHistory = [101];
  room.playerStats = {};
  room.historyRecorded = false;
  room.batuutaSequence = 0;
  
  // ── HALKAAN WAA LA SAXAY: Waa inuu ahaan Array ee uusan ahaan Object ──
  room.moveHistory = [];

  /*
   * MUHIIM:
   *
   * initializeRoomScores() hadda waxay marka ay aragto
   * room.gameStarted === true:
   *
   * +1/+1  -> kaydisaa Dabaaq -> 0/0
   * -1/-1  -> kaydisaa Dabaaq -> 0/0
   *
   * Score-yada kale lama taabanayo.
   */
  const season = initializeRoomScores(
    room,
    room.xiiliTarget || 5
  );
  // Pair-ka ciyaartan ha noqdo mid la qabtay marka ciyaartu bilaabatay.
  // Sidaas ayuu u sii jiri doonaa ilaa ciyaartan dhammaato, xitaa haddii
  // session-ka global-ka ah la refresh-gareeyo ama room kale la lifaaqo.
  room.activeDabaaqPairs = Array.isArray(room.dabaaqPairs)
    ? room.dabaaqPairs.map(pair => ({ ...pair }))
    : [];

  const gd = prepareGame();

  room.stockPile = gd.remainingDeck;

  room.players.forEach((p, i) => {
    resetPlayerState(p);

    p.hand = gd.allHands[i];

    if (i === 0) {
      p.hasActioned = true;
    }

    if (!p.isBot) {
      io.to(p.id).emit(
        'startHand',
        p.hand
      );
    }
  });

  if (room.stockPile.length > 0) {
    room.discardPile = [
      room.stockPile.pop()
    ];
  }

  const topDiscard =
    room.discardPile[
      room.discardPile.length - 1
    ];

  const firstPlayer = room.players[0];

  room.players.forEach(p => {
    if (!p.isBot) {
      io.to(p.id).emit('matchFound', {
        roomId,
        topDiscard,
        currentTurn: firstPlayer.id
      });
    }
  });

  io.to(roomId).emit(
    'updateStockCount',
    room.stockPile.length
  );

  broadcastTableUI(roomId);

  startTurnTimer(roomId);

  updateRoomPlayers(roomId);

  /*
   * U dir dadka score-ka cusub:
   *
   * Tusaale:
   * Abshir +1
   * Jimcaale +1
   *
   * kadib startGame:
   *
   * Abshir 0
   * Jimcaale 0
   *
   * Dabaaqda waxay ku jirtaa season.dabaaqPairs.
   */
  broadcastSessionScores(roomId);
}

function addBotsAndStartGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted || room._botsAdding) return;
  room._botsAdding = true;
  const botNames = ['Jaamac', 'Jimcaale', 'Faarax'];
  const needed = 4 - room.players.length;
  for (let i = 0; i < needed; i++) {
    const botId = `bot_${Math.random().toString(36).slice(2, 9)}`;
    room.players.push({ id: botId, name: botNames[i], hand: [], isOpened: false, hasActioned: false, pickedFromDiscard: false, lastPickedCardId: null, dabaaqProviderId: null, openedSets: [], online: true, points: 0, tempScore: 0, isBot: true, hoosgale: false, openProviderId: null, sessionToken: null, disconnectedAt: null, profileName: null });
    io.to(roomId).emit('waitingRoomUpdate', { players: room.players.map(p => ({ name: p.name, isBot: p.isBot })) });
  }
  setTimeout(() => { room._botsAdding = false; startGame(roomId); }, 1500);
}

// ─── Socket events ────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let myRoomId = '';

  socket.on('sendChat', message => {
    const room = rooms[myRoomId];
    if (!room) return;

    const player = room.players.find(pl => pl.id === socket.id);
    const cleanMessage = String(message || '').trim().slice(0, 500);
    if (!player || !cleanMessage) return;

    io.to(myRoomId).emit('receiveChat', {
      senderName: player.name,
      message: cleanMessage,
      time: Date.now()
    });
  });

  socket.on('joinRandom', (data) => {
    const name = typeof data === 'string' ? data : data.name;
    const incomingToken = typeof data === 'string' ? null : data.token;
    const profileName = typeof data === 'string' ? null : (data.profileName || null);
    const xiiliTarget = typeof data === 'string' ? 5 : (parseInt(data.xiiliTarget) || 5);

    for (const id in rooms) {
      const room = rooms[id];
      const existing = room.players.find(p => p.name === name && !p.online && !p.isBot);
      if (existing) {
        const tokenMatches = incomingToken && existing.sessionToken && incomingToken === existing.sessionToken;
        const isRecent = existing.disconnectedAt !== null && Date.now() - existing.disconnectedAt < RECONNECT_WINDOW_MS;
        if (tokenMatches && isRecent) {
          const oldId = existing.id;
          existing.id = socket.id; existing.online = true; existing.disconnectedAt = null;
          if (room.firstOpenerId === oldId) room.firstOpenerId = socket.id;
          myRoomId = id; socket.join(id);
          socket.emit('sessionToken', existing.sessionToken);
          socket.emit('startHand', existing.hand);
          if (room.discardPile.length > 0) socket.emit('updateDiscardPile', room.discardPile[room.discardPile.length - 1]);
          broadcastTableUI(id);
          const cur = room.players[room.activePlayerIndex];
          socket.emit('matchFound', { roomId: id, topDiscard: room.discardPile[room.discardPile.length - 1], currentTurn: cur ? cur.id : null });
          updateRoomPlayers(id);
          socket.emit('notification', 'Waad ku soo laabtay!');
          broadcastSessionScores(id);
          if (room.gameStarted && cur && cur.isBot && !room.turnTimeout && !room.isPaused) scheduleBotTurn(id, cur.id);
          return;
        }
      }
    }

    let rid = Object.keys(rooms).find(id => rooms[id].players.length < 4 && !rooms[id].gameStarted);
    if (!rid) {
      rid = 'Room_' + Math.random().toString(36).slice(2, 11);
      rooms[rid] = {
        id: rid, players: [], gameStarted: false, stockPile: [], discardPile: [],
        activePlayerIndex: 0, lastOpenPoints: 101, turnTimeout: null, turnStartTime: null,
        lastProviderId: null, botFillTimer: null, isPaused: false, pauseTimeLeft: 0,
        turnToken: 0, hasFirstOpened: false, firstOpenerId: null, firstOpenerOriginalPoints: null,
        barrierFrozen: false, openedPlayerIds: new Set(), barrierHistory: [101],
        playerStats: {}, moveHistory: [],
        dabaaqPairs: [], activeDabaaqPairs: [],
        sessionScores: {},
        xiiliTarget: xiiliTarget,
        historyRecorded: false,
      };
    }

    const sessionToken = genToken();
    const room = rooms[rid];
    // Hubi xiiliTarget-ka qolka hadduu u dhignaado kan cusub (qofka koowaad ayaa go'aaminaya)
    if (!room.gameStarted && room.players.length === 0) {
      room.xiiliTarget = xiiliTarget;
    }
    room.players.push({ id: socket.id, name: name || `User_${socket.id.slice(0, 4)}`, hand: [], isOpened: false, hasActioned: false, pickedFromDiscard: false, lastPickedCardId: null, dabaaqProviderId: null, openedSets: [], online: true, points: 0, tempScore: 0, isBot: false, hoosgale: false, openProviderId: null, sessionToken, disconnectedAt: null, profileName: profileName || null });
    socket.join(rid); myRoomId = rid;
    socket.emit('sessionToken', sessionToken);
    io.to(rid).emit('waitingRoomUpdate', { players: room.players.map(p => ({ name: p.name, isBot: p.isBot })) });
    broadcastSessionScores(rid);

    if (room.players.length === 4) {
      if (room.botFillTimer) { clearTimeout(room.botFillTimer); room.botFillTimer = null; }
      startGame(rid); return;
    }
    if (room.players.length === 1) {
      room.botFillTimer = setTimeout(() => {
        if (rooms[rid] && !rooms[rid].gameStarted && rooms[rid].players.length < 4) {
          io.to(rid).emit('notification', 'Waa la waayey ciyaartoy caadi ah — Sidaa darteed waxaa kula ciyaari doona Robot!');
          addBotsAndStartGame(rid);
        }
      }, 10000);
    }
  });

  socket.on('addBots', () => {
    if (!myRoomId) { for (const id in rooms) if (rooms[id].players.some(p => p.id === socket.id)) { myRoomId = id; break; } }
    if (!myRoomId) { socket.emit('notification', 'Qolka la heli waayo.'); return; }
    const room = rooms[myRoomId]; if (!room || room.gameStarted) return;
    if (room.botFillTimer) { clearTimeout(room.botFillTimer); room.botFillTimer = null; }
    addBotsAndStartGame(myRoomId);
  });

  socket.on('updatePenaltyScore', (data) => {
    const room = rooms[myRoomId]; if (!room) return;
    const p = room.players.find(pl => pl.id === data.playerId);
    if (p) { p.points += data.points; io.to(myRoomId).emit('scoreUpdated', { playerId: p.id, newTotal: p.points }); }
  });

  socket.on('drawCard', () => {
    const room = rooms[myRoomId]; if (!room || !room.gameStarted) return;
    const p = room.players[room.activePlayerIndex];
    if (!p || p.id !== socket.id) { socket.emit('notification', 'Sug doorkaaga!'); return; }
    if (p.hand.length >= 15) { socket.emit('notification', 'Ma qaadan kartid kaar kale. Mid tuur marka hore!'); return; }
    if (p.hasActioned) { socket.emit('notification', 'Horey ayaad u qaadatay kaar.'); return; }
    refillStockIfEmpty(myRoomId);
    if (room.stockPile.length > 0) {
      const card = room.stockPile.pop();
      p.hand.push(card); p.hasActioned = true; p.pickedFromDiscard = false; p.lastPickedCardId = null;
      socket.emit('receiveCard', card);
      io.to(myRoomId).emit('updateStockCount', room.stockPile.length);
      updateRoomPlayers(myRoomId);
    }
  });

  socket.on('pickDiscard', () => {
    const room = rooms[myRoomId];
    if (!room || !room.gameStarted) return;
    const p = room.players[room.activePlayerIndex];
    if (!p || p.id !== socket.id || p.hasActioned) return;
    if (room.discardPile.length > 0) {
      const card = room.discardPile.pop();
      const providerId = room.lastProviderId;
      if (providerId) {
        if (!room.playerStats) room.playerStats = {};
        if (!room.playerStats[p.id]) room.playerStats[p.id] = { pickedFrom: {} };
        room.playerStats[p.id].pickedFrom[providerId] = (room.playerStats[p.id].pickedFrom[providerId] || 0) + 1;
        if (!room.moveHistory) room.moveHistory = [];
        room.moveHistory.push({ playerId: p.id, playerName: p.name, card: `${card.suit}${card.value}`, fromId: providerId, time: Date.now() });
      }
      p.hand.push(card); p.hasActioned = true; p.pickedFromDiscard = true; p.lastPickedCardId = card.id;
      p.dabaaqProviderId = providerId || null;
      socket.emit('discardPickedSuccess', { card });
      socket.emit('updateHand', { hand: p.hand });
      io.to(myRoomId).emit('updateDiscardPile', room.discardPile[room.discardPile.length - 1] ?? null);
      updateRoomPlayers(myRoomId);
    }
  });

  socket.on('returnDiscardCard', () => {
    const room = rooms[myRoomId]; if (!room || !room.gameStarted) return;
    const p = room.players[room.activePlayerIndex];
    if (!p || p.id !== socket.id || !p.pickedFromDiscard) return;
    const cardIdx = p.hand.findIndex(c => c.id === p.lastPickedCardId);
    // Haddii kaarkii la qaatay uusan gacanta ku jirin, ha laga saarin
    // kaar kale oo aan la xiriirin. Tani waxay ka ilaalisaa in "Soo Celi"
    // uu si khalad ah u tirtiro kaarka ugu dambeeya ee gacanta.
    if (cardIdx === -1) {
      socket.emit('notification', 'Kaarkii tuurka la qaatay lama hayo; ma jiro kaar kale oo la soo celin karo.');
      return;
    }
    const top = p.hand.splice(cardIdx, 1)[0];
    room.discardPile.push(top);
    p.hasActioned = false; p.pickedFromDiscard = false; p.lastPickedCardId = null;
    p.dabaaqProviderId = null;
    socket.emit('updateHand', { hand: p.hand });
    io.to(myRoomId).emit('updateDiscardPile', top);
    socket.emit('discardReturnedSuccess');
  });

  socket.on('playCard', (data) => {
    const room = rooms[myRoomId]; if (!room || !room.gameStarted) return;
    const card = data.card || data; if (!card || !card.id) return;
    const p = room.players[room.activePlayerIndex];
    if (!p || p.id !== socket.id) { socket.emit('notification', 'Sug doorkaaga!'); return; }
    if (p.pickedFromDiscard && p.lastPickedCardId) {
      socket.emit('notification', '❌ Kaarka tuurka aad qaadatay marka hore ku dar koox miiska saaran.');
      return;
    }

    const isLastCardOpened = p.isOpened && p.hand.length === 1;
    if (!p.hasActioned && !isLastCardOpened) { socket.emit('notification', 'Marka hore kaar qaado!'); return; }

    const idx = p.hand.findIndex(c => c.id === card.id);
    if (idx === -1) { if (p.hasActioned && p.hand.length <= 14) { room.turnToken = (room.turnToken || 0) + 1; moveToNextPlayer(myRoomId); } return; }

    const nextIdx = (room.activePlayerIndex + 1) % room.players.length;
    const nextPlayer = room.players[nextIdx];
    if (!p.isOpened && p.hand.length > 1 && nextPlayer && nextPlayer.isOpened) {
      const allTableSets = room.players.flatMap(pl => pl.openedSets || []);
      if (!data.isDegaya && isCardMeelGale(card, allTableSets)) {
        socket.emit('notification', '❌ Waa meel-gale! Ciyaaryahanka ku xiga wuu degay, marka ma tuuri kartid meel-gale.');
        return;
      }
    }

    if (room.turnTimeout) { clearTimeout(room.turnTimeout); room.turnTimeout = null; }
    room.turnToken = (room.turnToken || 0) + 1;
    const discarded = p.hand.splice(idx, 1)[0];
    room.discardPile.push(discarded);
    io.to(myRoomId).emit('updateDiscardPile', discarded);
    socket.emit('updateHand', { hand: p.hand });

    if (p.hand.length === 0) { endGame(myRoomId, p); return; }
    room.lastProviderId = p.id;

    if (handleBatuutaAfterDiscard(myRoomId, p)) return;

    if (
      p.pickedFromDiscard &&
      !p.hoosgale &&
      !p.isOpened &&
      sessionHasPreviousFooro(room)
    ) {
      p.hoosgale = true;
      room.batuutaSequence = (Number(room.batuutaSequence) || 0) + 1;
      p.hoosgaleOrder = room.batuutaSequence;
      room.stockPile = shuffle([...room.stockPile, ...p.hand]);
      p.hand = [];
      socket.emit('hoosgaleTriggered');
      io.to(myRoomId).emit('notification', `⚠️ ${p.name} HOOSGALE!`);
      updateRoomPlayers(myRoomId);
      if (finishIfAllBatuuto(myRoomId)) return;
    }
    moveToNextPlayer(myRoomId);
  });

  socket.on('meldSets', (data) => {
    const room = rooms[myRoomId]; if (!room || !room.gameStarted) return;
    const p = room.players[room.activePlayerIndex];
    if (!p || p.id !== socket.id) { socket.emit('notification', 'Sug doorkaaga ka hor inta aadan degin!'); return; }
    if (p.isOpened && !data.isAdditional) { socket.emit('notification', 'Horey ayaad u furatay ciyaarta!'); return; }

    const requestedSets = Array.isArray(data?.sets) ? data.sets : [];
    const handById = new Map(p.hand.map(card => [card.id, card]));
    const selectedIds = requestedSets.flat().map(card => card?.id);
    const hasDuplicateIds = new Set(selectedIds).size !== selectedIds.length;
    const authoritativeSets = requestedSets.map(set =>
      Array.isArray(set) ? set.map(card => handById.get(card?.id)).filter(Boolean) : []
    );
    const setsAreValid = requestedSets.length > 0 &&
      !hasDuplicateIds &&
      requestedSets.every((set, index) =>
        Array.isArray(set) &&
        set.length === authoritativeSets[index].length &&
        isValidMeldSet(authoritativeSets[index])
      );
    if (!setsAreValid) {
      socket.emit('notification', '❌ Set-ka waa inuu noqdaa taxane isku calaamad ah ama tiro isku mid ah oo calaamado kala duwan leh.');
      socket.emit('meldRejected', { hand: p.hand });
      return;
    }

    const lagaMaMaarmaan = getOpeningMinimum(room);
    
    // Hubi saxnaanta variable-ka kaarka tuurka (isticmaal midkaaga saxda ah ama labadaba)
    const discardCardId = p.lastPickedDiscardId || p.lastPickedCardId;
    const pickedDiscardMustBeUsed = p.pickedFromDiscard && discardCardId
      ? cardIsInGroups(authoritativeSets, discardCardId)
      : true;
      
    if (!pickedDiscardMustBeUsed) {
      socket.emit('notification', '❌ Kaarka tuurka aad qaadatay waa inaad ku darto kooxaha aad dhigeyso.');
      socket.emit('meldRejected', { hand: p.hand });
      return;
    }
    
    const actualTotalScore = authoritativeSets.flat()
      .reduce((score, card) => score + getCardPoints(card.value), 0);
    if (!p.isOpened && actualTotalScore < lagaMaMaarmaan) {
      socket.emit('notification', `❌ Khalad: Waxaad u baahan tahay ${lagaMaMaarmaan} dhibco si aad u degto.`);
      socket.emit('meldRejected', { hand: p.hand }); return;
    }
    if (!p.isOpened && !authoritativeSets.some(set => set.length >= 4)) {
      socket.emit('notification', '❌ Waa inaad haysataa ugu yaraan hal set oo 4 kaar ah ama ka badan si aad u degto!');
      socket.emit('meldRejected', { hand: p.hand }); return;
    }

    const finalSets = [];
    authoritativeSets.forEach(set => {
      let processedSet = set;
      if (set.length === 6) { finalSets.push(set.slice(0, 3), set.slice(3, 6)); }
      else if (set.length === 7) { finalSets.push(set.slice(0, 4), set.slice(4, 7)); }
      else { finalSets.push(set); }
    });

    // 🔴 HALKAAN WAA IN LA CALAAMADIYAA KAARKA TUURKA EE MIISKA AADAY
    if (p.pickedFromDiscard && discardCardId) {
      finalSets.forEach(set => {
        set.forEach(card => {
          if (card.id === discardCardId) {
            card.isFromDiscard = true; // Tani waxay keenaysaa in UI-gu aqoonsado oo uu ka dhigo xiddig-leh
          }
        });
      });
    }

    const ids = new Set(authoritativeSets.flat().map(c => c.id));
    p.hand = p.hand.filter(c => !ids.has(c.id));
    const wasOpenedBefore = p.isOpened;
    if (!wasOpenedBefore && p.pickedFromDiscard) p.openProviderId = p.dabaaqProviderId || null;
    p.isOpened = true; p.openedSets.push(...finalSets);
    
    if (p.pickedFromDiscard && cardIsInGroups(authoritativeSets, discardCardId)) {
      p.pickedFromDiscard = false;
      p.lastPickedDiscardId = null;
      p.lastPickedCardId = null;
    }
    if (!room.openedPlayerIds) room.openedPlayerIds = new Set();
    room.openedPlayerIds.add(p.id);

    if (!wasOpenedBefore) {
      if (!room.hasFirstOpened) {
        room.hasFirstOpened = true; room.firstOpenerId = p.id;
        room.firstOpenerOriginalPoints = getPlayerOpenedPoints(p);
        room.lastOpenPoints = room.firstOpenerOriginalPoints + 1;
        io.to(myRoomId).emit('notification', `📢 ${p.name} ayaa degay! Ugu yaraan waxa laga rabaa ciyaartoyda kale waa: ${room.lastOpenPoints}`);
      } else {
        recalculateRoomBarrier(room);
        io.to(myRoomId).emit('notification', `🎉 ${p.name} ayaa degey!`);
      }
    } else {
      const oldBarrier = room.lastOpenPoints;
      recalculateRoomBarrier(room);
      if (room.lastOpenPoints !== oldBarrier) io.to(myRoomId).emit('notification', `📢 ${p.name} ayaa kordhiyay dhibcihiisii! Ugu yaraan inta la degi karaa waa: ${room.lastOpenPoints}`);
    }

    socket.emit('updateHand', { hand: p.hand });
    broadcastTableUI(myRoomId); updateRoomPlayers(myRoomId);
    if (p.hand.length === 0) { endGame(myRoomId, p); return; }
});

  socket.on('addToExistingSets', (data) => {
    const room = rooms[myRoomId]; if (!room || !room.gameStarted) return;
    const p = room.players.find(pl => pl.id === socket.id); if (!p || !p.isOpened) return;

    const requestedCards = Array.isArray(data?.cards) ? data.cards : [];
    if (p.pickedFromDiscard && p.lastPickedCardId &&
        !requestedCards.some(card => card?.id === p.lastPickedCardId)) {
      socket.emit('notification', '❌ Kaarka tuurka aad qaadatay waa inaad ku darto koox miiska saaran.');
      return;
    }

    const cardsById = new Map(p.hand.map(card => [card.id, card]));
    const cardsToAdd = requestedCards.map(card => cardsById.get(card?.id)).filter(Boolean);
    if (cardsToAdd.length !== requestedCards.length ||
        cardsToAdd.some(card => !cardFitsAnyOpenedSet(room, card))) {
      socket.emit('notification', '❌ Kaar ka mid ah kuwa aad dooratay kuma dari karo koox miiska saaran.');
      return;
    }

    cardsToAdd.forEach(card => {
      room.players.forEach(player => {
        (player.openedSets || []).forEach(set => {
          if (isCardMeelGale(card, [set]) && !set.some(c => c.id === card.id)) set.push(card);
        });
      });
    });
    const ids = new Set(cardsToAdd.map(c => c.id));
    p.hand = p.hand.filter(c => !ids.has(c.id));
    if (p.pickedFromDiscard && ids.has(p.lastPickedCardId)) {
      p.pickedFromDiscard = false;
      p.lastPickedCardId = null;
      socket.emit('discardCardUsed');
    }
    socket.emit('updateHand', { hand: p.hand });

    const oldBarrier = room.lastOpenPoints;
    recalculateRoomBarrier(room);
    if (room.lastOpenPoints !== oldBarrier) io.to(myRoomId).emit('notification', `📢 Ugu yaraan waa in aad gaartaa: ${room.lastOpenPoints}`);

    if (p.hand.length === 0) { broadcastTableUI(myRoomId); updateRoomPlayers(myRoomId); endGame(myRoomId, p); return; }

    broadcastTableUI(myRoomId); updateRoomPlayers(myRoomId);
  });
  
  socket.on('syncHandAfterMeld', (hand) => {
    const room = rooms[myRoomId]; if (!room || !room.gameStarted) return;
    const p = room.players.find(pl => pl.id === socket.id); if (!p) return;
    p.hand = hand; updateRoomPlayers(myRoomId);
  });

  socket.on('resetMyOpenedCards', () => {
    const room = rooms[myRoomId]; if (!room) return;
    const p = room.players.find(pl => pl.id === socket.id); if (!p || p.isOpened) return;
    p.openedSets = []; p.tempScore = 0;
    socket.emit('startHand', p.hand); broadcastTableUI(myRoomId);
  });

  socket.on('request_sync', () => {
    if (myRoomId && rooms[myRoomId]) {
      updateRoomPlayers(myRoomId);
      const room = rooms[myRoomId];
      if (room.discardPile.length > 0) socket.emit('updateDiscardPile', room.discardPile[room.discardPile.length - 1]);
      broadcastSessionScores(myRoomId);
    }
  });

  socket.on('forceResetGame', () => {
    const room = rooms[myRoomId]; if (!room) return;
    if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
    room.gameStarted = false; room.stockPile = []; room.discardPile = [];
    room.turnToken = 0; room.hasFirstOpened = false; room.firstOpenerId = null;
    room.firstOpenerOriginalPoints = null; room.barrierFrozen = false;
    room.openedPlayerIds = new Set(); room.playerStats = {}; room.moveHistory = [];
    if (room.turnTimeout) { clearTimeout(room.turnTimeout); room.turnTimeout = null; }
    room.players.forEach(resetPlayerState);
    io.to(myRoomId).emit('notification', '⚠️ Ciyaartu dib ayay u bilaabanaysaa...');
    setTimeout(() => startGame(myRoomId), 2000);
  });

  socket.on('startNewSeason', () => {
    const room = rooms[myRoomId];
    const target = room ? room.xiiliTarget : 5;
    resetXiiliSession(target);
    if (room) {
      attachRoomToXiiliSession(room, target);
      broadcastSessionScores(myRoomId);
    }
  });

  socket.on('pauseTimer', () => {
    const room = rooms[myRoomId]; if (!room || !room.gameStarted) return;
    const cur = room.players[room.activePlayerIndex]; if (!cur || cur.id !== socket.id) return;
    if (!room.isPaused) {
      const elapsed = Date.now() - (room.turnStartTime ?? Date.now());
      room.pauseTimeLeft = Math.max(5000, TURN_TIME_LIMIT - elapsed);
    }
    room.isPaused = true; if (room.turnTimeout) { clearTimeout(room.turnTimeout); room.turnTimeout = null; }
    io.to(myRoomId).emit('timerPaused', { activePlayerId: socket.id, message: `⏸️ ${cur.name} baa dalbaday in la sugo!` });
  });

  socket.on('resumeTimer', () => {
    const room = rooms[myRoomId]; if (!room || !room.gameStarted || !room.isPaused) return;
    const cur = room.players[room.activePlayerIndex]; if (!cur || cur.id !== socket.id) return;
    room.isPaused = false; room.turnStartTime = Date.now() - (TURN_TIME_LIMIT - room.pauseTimeLeft);
    if (room.turnTimeout) clearTimeout(room.turnTimeout);
    const token = room.turnToken;
    room.turnTimeout = setTimeout(() => {
      if (!room.isPaused && room.gameStarted && rooms[myRoomId]?.turnToken === token) moveToNextPlayer(myRoomId);
    }, room.pauseTimeLeft);
    io.to(myRoomId).emit('timerResumed');
  });

  socket.on('getLeaderboard', () => {
    socket.emit('leaderboardUpdate', { leaderboard: getLeaderboardData() });
  });

  socket.on('getWinnerHistory', () => {
    socket.emit('winnerHistoryUpdate', winnerHistory.getSummary());
  });

  socket.on('clearWinnerHistory', () => {
    const summary = winnerHistory.clear();
    io.emit('winnerHistoryUpdate', summary);
  });

  socket.on('ping_keep_alive', () => socket.emit('pong_alive'));
  socket.on('animation_finished', () => {});

  socket.on('leaveGame', () => {
    const room = rooms[myRoomId]; if (!room) return;
    if (!room.gameStarted) {
      room.players = room.players.filter(p => p.id !== socket.id);
    } else {
      const pidx = room.players.findIndex(p => p.id === socket.id);
      if (pidx !== -1) {
        const botNames = ['Jaamac', 'Jimcaale', 'Faarax'];
        const usedNames = room.players.map(p => p.name);
        const botName = botNames.find(n => !usedNames.includes(n)) ?? `BOT_${Math.random().toString(36).slice(2, 6)}`;
        const leaving = room.players[pidx];
        leaving.isBot = true; leaving.name = botName; leaving.online = true;
        leaving.sessionToken = null; leaving.disconnectedAt = null;
        updateRoomPlayers(myRoomId);
        if (room.activePlayerIndex === pidx) {
          if (room.turnTimeout) clearTimeout(room.turnTimeout);
          scheduleBotTurn(myRoomId, leaving.id);
        }
      }
    }
    socket.leave(myRoomId); myRoomId = '';
  });

  socket.on('disconnect', () => {
    const room = rooms[myRoomId]; if (!room) return;
    const pidx = room.players.findIndex(p => p.id === socket.id); if (pidx === -1) return;
    const player = room.players[pidx];
    if (!room.gameStarted) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.botFillTimer && room.players.length === 0) { clearTimeout(room.botFillTimer); room.botFillTimer = null; }
    } else {
      player.online = false; player.disconnectedAt = Date.now();
      if (room.activePlayerIndex === pidx) {
        if (room.turnTimeout) clearTimeout(room.turnTimeout);
        moveToNextPlayer(myRoomId);
      }
    }
    const online = room.players.filter(p => p.online || p.isBot).length;
    if (online === 0) { if (room.turnTimeout) clearTimeout(room.turnTimeout); delete rooms[myRoomId]; }
    else updateRoomPlayers(myRoomId);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`Turubka 101 ✅ wuxuu ku shaqeynayaa port ${PORT}`);
});
