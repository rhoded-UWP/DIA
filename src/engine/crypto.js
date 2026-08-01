/**
 * Passphrase encryption for the re-identification map.
 *
 * The map is the most sensitive artifact this application produces — it is the list of
 * who is who. Encryption is on by default so a copy left in a Downloads folder is not a
 * roster.
 *
 * Parameters are fixed here rather than negotiated per file:
 *   AES-256-GCM, 128-bit tag
 *   PBKDF2-SHA-256, 600,000 iterations on write
 *   128-bit salt, 96-bit IV, both fresh per encryption, both from getRandomValues
 *
 * The plaintext envelope fields are bound to the ciphertext as additional authenticated
 * data, so an attacker cannot swap the declared algorithm and have it accepted.
 */

export const CRYPTO_PARAMS = {
  envelopeVersion: 1,
  kdf: 'PBKDF2-SHA256',
  cipher: 'AES-256-GCM',
  iterations: 600_000,
  // A hostile file could otherwise ask for a billion iterations and freeze the tab, or
  // one iteration and be trivially crackable. Both ends are refused.
  minIterations: 100_000,
  maxIterations: 2_000_000,
  saltBytes: 16,
  ivBytes: 12,
  tagBits: 128,
};

const subtle = () => globalThis.crypto.subtle;

function toBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The exact bytes bound to the ciphertext. Field order is fixed so encryption and
 * decryption always build the identical string.
 */
function additionalData(envelope) {
  return new TextEncoder().encode(JSON.stringify({
    app: 'dia',
    envelopeVersion: envelope.envelopeVersion,
    kdf: envelope.kdf,
    cipher: envelope.cipher,
  }));
}

async function deriveKey(passphrase, salt, iterations) {
  // The passphrase is used exactly as typed. Trimming it would silently change the key
  // and make a correct passphrase fail on a different build.
  const material = await subtle().importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** @returns {Promise<object>} the JSON-serializable envelope */
export async function encryptMap(plaintext, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('A passphrase is required.');
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(CRYPTO_PARAMS.saltBytes));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(CRYPTO_PARAMS.ivBytes));

  const envelope = {
    app: 'dia',
    encrypted: true,
    envelopeVersion: CRYPTO_PARAMS.envelopeVersion,
    kdf: CRYPTO_PARAMS.kdf,
    cipher: CRYPTO_PARAMS.cipher,
    iterations: CRYPTO_PARAMS.iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: '',
  };

  const key = await deriveKey(passphrase, salt, CRYPTO_PARAMS.iterations);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(envelope), tagLength: CRYPTO_PARAMS.tagBits },
    key,
    new TextEncoder().encode(plaintext),
  );
  envelope.ciphertext = toBase64(new Uint8Array(ct));
  return envelope;
}

export function isEncryptedEnvelope(obj) {
  return !!obj && typeof obj === 'object' && obj.app === 'dia' && obj.encrypted === true;
}

/**
 * @returns {Promise<string>} the plaintext map JSON
 * @throws {Error} with a deliberately generic message — a wrong passphrase and a
 *                 corrupted or tampered file are indistinguishable to the user, and
 *                 should be, since GCM cannot tell us which one happened.
 */
export async function decryptMap(envelope, passphrase) {
  if (!isEncryptedEnvelope(envelope)) throw new Error('That file is not an encrypted map.');
  if (envelope.envelopeVersion !== CRYPTO_PARAMS.envelopeVersion) {
    throw new Error(`This encrypted map uses envelope version ${envelope.envelopeVersion}; this build understands ${CRYPTO_PARAMS.envelopeVersion}.`);
  }
  if (envelope.kdf !== CRYPTO_PARAMS.kdf || envelope.cipher !== CRYPTO_PARAMS.cipher) {
    throw new Error('This encrypted map uses an algorithm this build does not support.');
  }
  const iterations = envelope.iterations;
  if (!Number.isInteger(iterations) || iterations < CRYPTO_PARAMS.minIterations || iterations > CRYPTO_PARAMS.maxIterations) {
    throw new Error(`Refusing to process this file: it requests ${iterations} key-derivation rounds, outside the accepted range of ${CRYPTO_PARAMS.minIterations.toLocaleString()} to ${CRYPTO_PARAMS.maxIterations.toLocaleString()}.`);
  }

  let salt, iv, ct;
  try {
    salt = fromBase64(envelope.salt);
    iv = fromBase64(envelope.iv);
    ct = fromBase64(envelope.ciphertext);
  } catch {
    throw new Error('Could not open the map. The passphrase may be wrong, or the file may be damaged.');
  }
  if (salt.length !== CRYPTO_PARAMS.saltBytes || iv.length !== CRYPTO_PARAMS.ivBytes || ct.length === 0) {
    throw new Error('Could not open the map. The passphrase may be wrong, or the file may be damaged.');
  }

  const key = await deriveKey(passphrase, salt, iterations);
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(envelope), tagLength: CRYPTO_PARAMS.tagBits },
      key,
      ct,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('Could not open the map. The passphrase may be wrong, or the file may be damaged.');
  }
}

/**
 * Encrypt, then immediately decrypt and compare before the file is offered for download.
 * A map that cannot be reopened is worse than no map at all, and the user would not find
 * out until grading day.
 */
export async function encryptMapVerified(plaintext, passphrase) {
  const envelope = await encryptMap(plaintext, passphrase);
  const roundTrip = await decryptMap(envelope, passphrase);
  if (roundTrip !== plaintext) {
    throw new Error('Encryption self-check failed. The map was not saved.');
  }
  return envelope;
}
