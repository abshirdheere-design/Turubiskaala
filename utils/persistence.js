import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function readJsonFile(filePath, fallback = {}) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, filePath);
}

export function createJsonStore(filePath, fallback = {}) {
  let value = readJsonFile(filePath, fallback);
  return {
    get: () => value,
    set: nextValue => {
      value = nextValue;
      atomicWriteJson(filePath, value);
      return value;
    },
    reload: () => {
      value = readJsonFile(filePath, fallback);
      return value;
    },
  };
}

/**
 * 🔴 MIDEEYAHA CUSUB (Synced Store): 
 * Wuxuu hubinayaa in profiles.json iyo profiles.backup.json ay isla mar walba isku mid noqdaan.
 */
export function createSyncedProfilesStore(primaryPath, backupPath, fallback = {}) {
  // Haddii profiles.json maqnaado ama dhibaato jirto, ka soo kabso backup-ka
  let initialData = readJsonFile(primaryPath, null);
  if (!initialData || Object.keys(initialData).length === 0) {
    initialData = readJsonFile(backupPath, fallback);
  }

  let value = initialData;

  // Si aysan u kala duwanaan bilowgaba, labada faylba ha la simo
  atomicWriteJson(primaryPath, value);
  atomicWriteJson(backupPath, value);

  return {
    get: () => value,
    set: nextValue => {
      value = nextValue;
      // Labada fayl isla markiiba hal mar ayaa loo wada qorayaa (Atomic Writes)
      atomicWriteJson(primaryPath, value);
      atomicWriteJson(backupPath, value);
      return value;
    },
    reload: () => {
      value = readJsonFile(primaryPath, readJsonFile(backupPath, fallback));
      return value;
    },
  };
}

// Tusaale sida aad uga dhex isticmaali karto server.js ama meelaha kale:
// const profilesStore = createSyncedProfilesStore(
//   join(__dirname, '../data/profiles.json'),
//   join(__dirname, '../data/profiles.backup.json')
// );
// const sessionsStore = createJsonStore(join(__dirname, '../data/sessions.json'));