/* ===========================================================================
 * secure.js — device-encrypted media containers with key-file backup
 *
 * Media is split into 1 MiB records, each AES-256-GCM encrypted. The 256-bit
 * key is stored as a user-held .key file (the permanent source of truth) and
 * cached in IndexedDB for convenience. If the browser flushes IndexedDB, the
 * user re-imports their key file to restore access.
 * ========================================================================== */

const DIGICAM_SECURE_MIME = 'application/x-digicam';
const DIGICAM_SECURE_EXTENSION = '.digicam';

const DGC_MAGIC = new Uint8Array([0x44, 0x47, 0x43, 0x31]); // "DGC1"
const DGC_VERSION = 1;
const DGC_HEADER_SIZE = 28;
const DGC_CHUNK_SIZE = 1024 * 1024;
const DGC_TAG_BYTES = 16;
const DGC_MAX_METADATA_BYTES = 64 * 1024;
const DGC_MAX_RECORDS = 100_000;

const DGC_DB_NAME = 'digicam-device-vault';
const DGC_DB_VERSION = 1;
const DGC_KEY_STORE = 'keys';
const DGC_KEY_ID = 'device-aes-gcm-v1';

const DIGICAM_KEY_FILE_EXTENSION = '.key';
const DIGICAM_KEY_FILE_VERSION = 1;

class DigicamSecureError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'DigicamSecureError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function requireDigicamSecureApis() {
  if (location.protocol === 'file:') {
    throw new DigicamSecureError(
      'ORIGIN_REQUIRED',
      'Encryption needs a stable localhost or HTTPS address.',
    );
  }
  if (!window.isSecureContext) {
    throw new DigicamSecureError(
      'INSECURE_CONTEXT',
      'Encryption is only available on localhost or HTTPS.',
    );
  }
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new DigicamSecureError(
      'CRYPTO_UNAVAILABLE',
      'This browser does not provide the required encryption APIs.',
    );
  }
}

function openDigicamKeyDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DGC_DB_NAME, DGC_DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DGC_KEY_STORE)) {
        db.createObjectStore(DGC_KEY_STORE);
      }
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(new DigicamSecureError(
        'KEY_STORAGE_FAILED',
        'The device key database could not be opened.',
        request.error,
      )),
      { once: true },
    );
    request.addEventListener(
      'blocked',
      () => reject(new DigicamSecureError(
        'KEY_STORAGE_BLOCKED',
        'Close other Digicam tabs and try again.',
      )),
      { once: true },
    );
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function idbTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error || new Error('IndexedDB transaction aborted')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error || new Error('IndexedDB transaction failed')),
      { once: true },
    );
  });
}

const DGC_RAW_KEY_ID = 'device-raw-v1';

function validDeviceKey(key) {
  return Boolean(
    key
    && key.type === 'secret'
    && key.algorithm?.name === 'AES-GCM'
    && key.usages?.includes('encrypt')
    && key.usages?.includes('decrypt'),
  );
}

function importRawKey(raw) {
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function readDeviceKey(db) {
  const transaction = db.transaction(DGC_KEY_STORE, 'readonly');
  const done = idbTransaction(transaction);
  const store = transaction.objectStore(DGC_KEY_STORE);

  // Prefer the raw-bytes format (reliable across all browsers and refreshes).
  const raw = await idbRequest(store.get(DGC_RAW_KEY_ID));
  // Also try the legacy CryptoKey format for backward compat.
  const legacy = await idbRequest(store.get(DGC_KEY_ID));
  await done;

  if (raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.byteLength === 32) return importRawKey(bytes);
  }

  // Legacy: a CryptoKey was stored directly (unreliable on mobile).
  if (legacy && validDeviceKey(legacy)) return legacy;

  // Corrupted data — return null so the key-file import flow can recover.
  return null;
}

async function addDeviceKey(db, rawBytes) {
  const transaction = db.transaction(DGC_KEY_STORE, 'readwrite');
  const done = idbTransaction(transaction);
  try {
    // Store the raw 256-bit key as a plain ArrayBuffer (universally reliable).
    await idbRequest(
      transaction.objectStore(DGC_KEY_STORE).add(rawBytes.buffer.slice(0), DGC_RAW_KEY_ID),
    );
    await done;
    return importRawKey(rawBytes);
  } catch (error) {
    await done.catch(() => {});
    if (error?.name === 'ConstraintError') return readDeviceKey(db);
    throw new DigicamSecureError(
      'KEY_STORAGE_FAILED',
      'The device-only key could not be stored.',
      error,
    );
  }
}

let cachedDeviceKey = null;
let cachedRawBytes = null;
let creatingDeviceKey = null;
let lastKeyWasNewlyCreated = false;

async function getDigicamDeviceKey({ create = true } = {}) {
  requireDigicamSecureApis();
  if (cachedDeviceKey) return cachedDeviceKey;
  if (creatingDeviceKey) return creatingDeviceKey;

  const readOrCreate = async () => {
    let db;
    try {
      db = await openDigicamKeyDb();
    } catch (_) {
      if (!create) {
        lastKeyWasNewlyCreated = false;
        return null;
      }
      // IndexedDB unavailable — generate key in memory only (key file is
      // the source of truth, so this still works).
      const rawBytes = crypto.getRandomValues(new Uint8Array(32));
      cachedRawBytes = rawBytes;
      lastKeyWasNewlyCreated = true;
      return importRawKey(rawBytes);
    }
    try {
      const existing = await readDeviceKey(db);
      if (existing || !create) {
        lastKeyWasNewlyCreated = false;
        return existing;
      }

      // Generate 256 random bits and store as raw bytes.
      const rawBytes = crypto.getRandomValues(new Uint8Array(32));
      cachedRawBytes = rawBytes;
      lastKeyWasNewlyCreated = true;
      return await addDeviceKey(db, rawBytes);
    } finally {
      db.close();
    }
  };

  if (!create) {
    const key = await readOrCreate();
    if (key) cachedDeviceKey = key;
    return key;
  }

  creatingDeviceKey = (
    navigator.locks?.request
      ? navigator.locks.request('digicam-device-key-v1', readOrCreate)
      : readOrCreate()
  )
    .then((key) => {
      if (!validDeviceKey(key)) {
        throw new DigicamSecureError(
          'KEY_STORAGE_FAILED',
          'The device-only key could not be verified.',
        );
      }
      cachedDeviceKey = key;
      navigator.storage?.persist?.().catch(() => {});
      return key;
    })
    .finally(() => {
      creatingDeviceKey = null;
    });

  return creatingDeviceKey;
}

function wasKeyNewlyCreated() {
  return lastKeyWasNewlyCreated;
}

/* ===========================================================================
 * Key file — the user-held source of truth
 * ========================================================================= */

function base64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function generateKeyFileJSON(rawBytes) {
  return JSON.stringify({
    v: DIGICAM_KEY_FILE_VERSION,
    k: base64urlEncode(rawBytes),
    created: new Date().toISOString(),
  });
}

function exportKeyFileBlob(rawBytes) {
  const json = generateKeyFileJSON(rawBytes);
  return new Blob([json], { type: 'application/json' });
}

function parseKeyFileJSON(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new DigicamSecureError('INVALID_KEY_FILE', 'The key file is not valid JSON.');
  }
  if (!parsed || parsed.v !== DIGICAM_KEY_FILE_VERSION) {
    throw new DigicamSecureError(
      'INVALID_KEY_FILE',
      'Unrecognized key file version.',
    );
  }
  if (typeof parsed.k !== 'string' || !parsed.k.length) {
    throw new DigicamSecureError('INVALID_KEY_FILE', 'The key file has no key data.');
  }
  let rawBytes;
  try {
    rawBytes = base64urlDecode(parsed.k);
  } catch (_) {
    throw new DigicamSecureError('INVALID_KEY_FILE', 'The key data is corrupted.');
  }
  if (rawBytes.byteLength !== 32) {
    throw new DigicamSecureError(
      'INVALID_KEY_FILE',
      'The key file does not contain a valid 256-bit key.',
    );
  }
  return rawBytes;
}

async function importKeyFile(file) {
  if (!(file instanceof Blob) || file.size > 4096) {
    throw new DigicamSecureError('INVALID_KEY_FILE', 'The file is not a valid key file.');
  }
  const text = await file.text();
  const rawBytes = parseKeyFileJSON(text);
  cachedRawBytes = rawBytes;
  await cacheRawKeyInIDB(rawBytes);
  const key = await importRawKey(rawBytes);
  cachedDeviceKey = key;
  return key;
}

async function cacheRawKeyInIDB(rawBytes) {
  try {
    const db = await openDigicamKeyDb();
    try {
      const transaction = db.transaction(DGC_KEY_STORE, 'readwrite');
      const store = transaction.objectStore(DGC_KEY_STORE);
      await idbRequest(store.put(rawBytes.buffer.slice(0), DGC_RAW_KEY_ID));
      await idbTransaction(transaction);
    } finally {
      db.close();
    }
  } catch (_) {
    // IDB caching is best-effort; the key file is the source of truth.
  }
}

async function getRawKeyBytes() {
  try {
    const db = await openDigicamKeyDb();
    try {
      const transaction = db.transaction(DGC_KEY_STORE, 'readonly');
      const done = idbTransaction(transaction);
      const store = transaction.objectStore(DGC_KEY_STORE);
      const raw = await idbRequest(store.get(DGC_RAW_KEY_ID));
      await done;
      if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
      if (raw instanceof Uint8Array) return raw;
    } finally {
      db.close();
    }
  } catch (_) {
    // IDB unavailable — fall through to in-memory cache.
  }
  return cachedRawBytes || null;
}

async function hasDeviceKey() {
  try {
    const db = await openDigicamKeyDb();
    try {
      const transaction = db.transaction(DGC_KEY_STORE, 'readonly');
      const done = idbTransaction(transaction);
      const raw = await idbRequest(transaction.objectStore(DGC_KEY_STORE).get(DGC_RAW_KEY_ID));
      const legacy = await idbRequest(transaction.objectStore(DGC_KEY_STORE).get(DGC_KEY_ID));
      await done;
      return Boolean(raw || legacy);
    } finally {
      db.close();
    }
  } catch (_) {
    return false;
  }
}

function isDigicamKeyFile(file) {
  return Boolean(
    file
    && String(file.name || '').toLowerCase().endsWith(DIGICAM_KEY_FILE_EXTENSION)
    && !String(file.name || '').toLowerCase().endsWith(DIGICAM_SECURE_EXTENSION),
  );
}

function isDigicamSecureFile(file) {
  return Boolean(
    file
    && (
      file.type === DIGICAM_SECURE_MIME
      || String(file.name || '').toLowerCase().endsWith(DIGICAM_SECURE_EXTENSION)
    ),
  );
}

function makeContainerHeader(recordCount, nonceBase) {
  const header = new Uint8Array(DGC_HEADER_SIZE);
  header.set(DGC_MAGIC, 0);
  header[4] = DGC_VERSION;
  const view = new DataView(header.buffer);
  view.setUint32(8, DGC_CHUNK_SIZE, false);
  view.setUint32(12, recordCount, false);
  header.set(nonceBase, 16);
  return header;
}

function parseContainerHeader(bytes) {
  if (bytes.byteLength !== DGC_HEADER_SIZE) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked file header is incomplete.');
  }
  for (let i = 0; i < DGC_MAGIC.length; i++) {
    if (bytes[i] !== DGC_MAGIC[i]) {
      throw new DigicamSecureError('NOT_DIGICAM', 'This is not a Digicam locked file.');
    }
  }
  if (bytes[4] !== DGC_VERSION) {
    throw new DigicamSecureError(
      'UNSUPPORTED_VERSION',
      'This locked file was written by an unsupported Digicam version.',
    );
  }
  if (bytes[5] || bytes[6] || bytes[7]) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked file header is invalid.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkSize = view.getUint32(8, false);
  const recordCount = view.getUint32(12, false);
  if (chunkSize < 64 * 1024 || chunkSize > 8 * 1024 * 1024) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked file chunk size is invalid.');
  }
  if (recordCount < 1 || recordCount > DGC_MAX_RECORDS) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked file record count is invalid.');
  }
  return {
    chunkSize,
    recordCount,
    nonceBase: bytes.slice(16, 28),
  };
}

function recordNonce(nonceBase, index) {
  const nonce = nonceBase.slice();
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  view.setUint32(8, (view.getUint32(8, false) + index) >>> 0, false);
  return nonce;
}

function recordAad(header, index) {
  const aad = new Uint8Array(header.byteLength + 4);
  aad.set(header);
  new DataView(aad.buffer).setUint32(header.byteLength, index, false);
  return aad;
}

function lengthPrefix(length) {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, length, false);
  return prefix;
}

function secureMetadata(blob, metadata) {
  const kind = metadata.kind;
  const mime = String(metadata.mime || blob.type || '');
  const allowed = (
    (kind === 'image' && mime.startsWith('image/') && mime !== 'image/gif')
    || (kind === 'video' && mime.startsWith('video/'))
    || (kind === 'animation' && mime === 'image/gif')
  );
  if (!allowed) {
    throw new DigicamSecureError('INVALID_MEDIA', 'This media type cannot be locked.');
  }

  const name = String(metadata.name || `media-${Date.now()}`)
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-')
    .slice(0, 180);
  const result = {
    schema: 1,
    kind,
    mime,
    name,
    size: blob.size,
    createdAt: new Date().toISOString(),
  };
  for (const key of ['w', 'h', 'duration']) {
    const value = Number(metadata[key]);
    if (Number.isFinite(value) && value >= 0) result[key] = value;
  }
  if (kind === 'video') result.hasAudio = Boolean(metadata.hasAudio);
  return result;
}

function validateSecureMetadata(metadata, fileSize, chunkSize, recordCount) {
  if (!metadata || metadata.schema !== 1) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked media description is invalid.');
  }
  const mime = String(metadata.mime || '');
  const validKind = (
    (metadata.kind === 'image' && mime.startsWith('image/') && mime !== 'image/gif')
    || (metadata.kind === 'video' && mime.startsWith('video/'))
    || (metadata.kind === 'animation' && mime === 'image/gif')
  );
  if (!validKind) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked media type is invalid.');
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > fileSize) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked media size is invalid.');
  }
  const expectedRecords = Math.ceil(metadata.size / chunkSize) + 1;
  if (expectedRecords !== recordCount) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked media record map is invalid.');
  }
  metadata.name = String(metadata.name || 'media')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-')
    .slice(0, 180);
  for (const key of ['w', 'h', 'duration']) {
    const value = Number(metadata[key]);
    metadata[key] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  metadata.hasAudio = metadata.kind === 'video' && Boolean(metadata.hasAudio);
  return metadata;
}

async function encryptDigicamBlob(blob, metadata, onProgress = () => {}) {
  const key = await getDigicamDeviceKey({ create: true });
  return encryptDigicamBlobWithKey(blob, metadata, key, onProgress);
}

async function encryptDigicamBlobWithKey(blob, metadata, key, onProgress = () => {}) {
  if (!(blob instanceof Blob) || !blob.size) {
    throw new DigicamSecureError('INVALID_MEDIA', 'There is no media to lock.');
  }
  if (!validDeviceKey(key)) {
    throw new DigicamSecureError('KEY_INVALID', 'The encryption key is invalid.');
  }
  const description = secureMetadata(blob, metadata);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(description));
  if (metadataBytes.byteLength > DGC_MAX_METADATA_BYTES) {
    throw new DigicamSecureError('INVALID_MEDIA', 'The media description is too large.');
  }

  const mediaRecordCount = Math.ceil(blob.size / DGC_CHUNK_SIZE);
  const recordCount = mediaRecordCount + 1;
  if (recordCount > DGC_MAX_RECORDS) {
    throw new DigicamSecureError('MEDIA_TOO_LARGE', 'This file is too large to lock safely.');
  }

  const nonceBase = crypto.getRandomValues(new Uint8Array(12));
  const header = makeContainerHeader(recordCount, nonceBase);
  const parts = [header];

  const encryptRecord = async (plain, index) => {
    const cipher = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: recordNonce(nonceBase, index),
        additionalData: recordAad(header, index),
        tagLength: 128,
      },
      key,
      plain,
    );
    parts.push(lengthPrefix(cipher.byteLength), cipher);
  };

  try {
    await encryptRecord(metadataBytes, 0);
    metadataBytes.fill(0);

    for (let i = 0; i < mediaRecordCount; i++) {
      const start = i * DGC_CHUNK_SIZE;
      const plain = new Uint8Array(
        await blob.slice(start, Math.min(blob.size, start + DGC_CHUNK_SIZE)).arrayBuffer(),
      );
      await encryptRecord(plain, i + 1);
      plain.fill(0);
      onProgress((i + 1) / mediaRecordCount);
      // Give the LCD a chance to paint progress between crypto jobs.
      if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    metadataBytes.fill(0);
    if (error instanceof DigicamSecureError) throw error;
    throw new DigicamSecureError(
      'ENCRYPTION_FAILED',
      'The media could not be locked.',
      error,
    );
  }

  return {
    blob: new Blob(parts, { type: DIGICAM_SECURE_MIME }),
    metadata: description,
  };
}

async function decryptDigicamFile(file, onProgress = () => {}) {
  if (!(file instanceof Blob) || file.size < DGC_HEADER_SIZE + 4 + DGC_TAG_BYTES) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked file is incomplete.');
  }
  requireDigicamSecureApis();
  const key = await getDigicamDeviceKey({ create: false });
  if (!key) {
    throw new DigicamSecureError(
      'KEY_MISSING',
      'This browser profile does not have the key that locked this file.',
    );
  }
  return decryptDigicamFileWithKey(file, key, onProgress);
}

async function decryptDigicamFileWithKey(file, key, onProgress = () => {}) {
  if (!(file instanceof Blob) || file.size < DGC_HEADER_SIZE + 4 + DGC_TAG_BYTES) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked file is incomplete.');
  }
  if (!validDeviceKey(key)) {
    throw new DigicamSecureError('KEY_INVALID', 'The decryption key is invalid.');
  }
  const header = new Uint8Array(await file.slice(0, DGC_HEADER_SIZE).arrayBuffer());
  const { chunkSize, recordCount, nonceBase } = parseContainerHeader(header);
  let offset = DGC_HEADER_SIZE;
  let metadata = null;
  let mediaSize = 0;
  const mediaParts = [];

  for (let index = 0; index < recordCount; index++) {
    if (offset + 4 > file.size) {
      throw new DigicamSecureError('CORRUPT_FILE', 'The locked file ended early.');
    }
    const lengthBytes = await file.slice(offset, offset + 4).arrayBuffer();
    const cipherLength = new DataView(lengthBytes).getUint32(0, false);
    offset += 4;

    const maxLength = index === 0
      ? DGC_MAX_METADATA_BYTES + DGC_TAG_BYTES
      : chunkSize + DGC_TAG_BYTES;
    if (
      cipherLength < DGC_TAG_BYTES
      || cipherLength > maxLength
      || offset + cipherLength > file.size
    ) {
      throw new DigicamSecureError('CORRUPT_FILE', 'A locked file record is invalid.');
    }

    const cipher = await file.slice(offset, offset + cipherLength).arrayBuffer();
    offset += cipherLength;
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: recordNonce(nonceBase, index),
          additionalData: recordAad(header, index),
          tagLength: 128,
        },
        key,
        cipher,
      );
    } catch (error) {
      throw new DigicamSecureError(
        'AUTH_FAILED',
        'This file belongs to another device, or its encrypted bytes were changed.',
        error,
      );
    }

    if (index === 0) {
      try {
        metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
      } catch (error) {
        throw new DigicamSecureError(
          'CORRUPT_FILE',
          'The locked media description is unreadable.',
          error,
        );
      }
      validateSecureMetadata(metadata, file.size, chunkSize, recordCount);
    } else {
      const expectedLength = Math.min(chunkSize, metadata.size - mediaSize);
      if (plain.byteLength !== expectedLength || expectedLength <= 0) {
        throw new DigicamSecureError('CORRUPT_FILE', 'A locked media chunk has the wrong size.');
      }
      mediaParts.push(plain);
      mediaSize += plain.byteLength;
      onProgress(index / (recordCount - 1));
      if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (offset !== file.size || !metadata || mediaSize !== metadata.size) {
    throw new DigicamSecureError('CORRUPT_FILE', 'The locked file has unexpected data.');
  }

  return {
    blob: new Blob(mediaParts, { type: metadata.mime }),
    metadata,
  };
}

/* Node's built-in test runner can exercise the exact container code with an
   injected non-exportable key. This branch does not exist in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DIGICAM_SECURE_MIME,
    DigicamSecureError,
    encryptDigicamBlobWithKey,
    decryptDigicamFileWithKey,
  };
}
