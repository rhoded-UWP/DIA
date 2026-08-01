import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptMap, decryptMap, encryptMapVerified, isEncryptedEnvelope, CRYPTO_PARAMS,
} from '../src/engine/crypto.js';

// PBKDF2 at 600k rounds is deliberately slow; these tests do a handful of derivations.
const PLAINTEXT = JSON.stringify({ app: 'dia', batchId: 'ABCD2345', entities: [] });
const PASSPHRASE = 'correct horse battery staple';

test('an encrypted map round-trips', async () => {
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);
  assert.ok(isEncryptedEnvelope(envelope));
  assert.equal(await decryptMap(envelope, PASSPHRASE), PLAINTEXT);
});

test('the envelope declares the agreed parameters', async () => {
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);
  assert.equal(envelope.cipher, 'AES-256-GCM');
  assert.equal(envelope.kdf, 'PBKDF2-SHA256');
  assert.equal(envelope.iterations, CRYPTO_PARAMS.iterations);
  assert.equal(atob(envelope.salt).length, 16, '128-bit salt');
  assert.equal(atob(envelope.iv).length, 12, '96-bit IV');
  assert.ok(!envelope.ciphertext.includes('ABCD2345'), 'ciphertext must not leak the plaintext');
});

test('salt and IV are fresh for every encryption', async () => {
  const a = await encryptMap(PLAINTEXT, PASSPHRASE);
  const b = await encryptMap(PLAINTEXT, PASSPHRASE);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv, 'reusing an IV with the same key would break AES-GCM');
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('a wrong passphrase fails with a generic message', async () => {
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);
  await assert.rejects(
    () => decryptMap(envelope, 'wrong passphrase'),
    /passphrase may be wrong, or the file may be damaged/,
  );
});

test('the passphrase is used exactly as typed', async () => {
  const envelope = await encryptMap(PLAINTEXT, '  spaced  ');
  await assert.rejects(() => decryptMap(envelope, 'spaced'), /passphrase may be wrong/);
  assert.equal(await decryptMap(envelope, '  spaced  '), PLAINTEXT);
});

test('tampered ciphertext is rejected', async () => {
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);
  const bytes = atob(envelope.ciphertext).split('');
  bytes[0] = bytes[0] === 'A' ? 'B' : 'A';
  envelope.ciphertext = btoa(bytes.join(''));
  await assert.rejects(() => decryptMap(envelope, PASSPHRASE), /may be damaged/);
});

test('the declared algorithm cannot be swapped', async () => {
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);

  // Two layers protect these fields. An explicit check refuses anything this build does
  // not implement, and the same fields are bound to the ciphertext as additional
  // authenticated data, so a value that slipped past the check would still fail the tag.
  await assert.rejects(() => decryptMap({ ...envelope, envelopeVersion: 2 }, PASSPHRASE), /envelope version/);
  await assert.rejects(() => decryptMap({ ...envelope, cipher: 'AES-128-CBC' }, PASSPHRASE), /does not support/);
  await assert.rejects(() => decryptMap({ ...envelope, kdf: 'scrypt' }, PASSPHRASE), /does not support/);

  assert.equal(await decryptMap({ ...envelope }, PASSPHRASE), PLAINTEXT, 'an untouched envelope still opens');
});

test('the AAD binding rejects an envelope whose bound fields were rewritten', async () => {
  // Encrypt an envelope, then present the ciphertext inside a differently-declared
  // envelope that still passes the explicit checks. The tag is computed over the
  // declared fields, so the swap is detected.
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);
  const forged = { ...envelope, app: 'dia-fork' };
  await assert.rejects(() => decryptMap(forged, PASSPHRASE), /not an encrypted map|damaged/);
});

test('a hostile iteration count is refused before any work happens', async () => {
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);
  const started = performance.now();
  await assert.rejects(
    () => decryptMap({ ...envelope, iterations: 5_000_000_000 }, PASSPHRASE),
    /outside the accepted range/,
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `refusal must be immediate, took ${elapsed.toFixed(0)}ms`);
});

test('a too-weak iteration count is also refused', async () => {
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);
  await assert.rejects(() => decryptMap({ ...envelope, iterations: 10 }, PASSPHRASE), /outside the accepted range/);
});

test('malformed envelope fields fail cleanly', async () => {
  const envelope = await encryptMap(PLAINTEXT, PASSPHRASE);
  await assert.rejects(() => decryptMap({ ...envelope, salt: 'not base64!!' }, PASSPHRASE), /Could not open|damaged/);
  await assert.rejects(() => decryptMap({ ...envelope, iv: btoa('short') }, PASSPHRASE), /damaged/);
  await assert.rejects(() => decryptMap({ ...envelope, ciphertext: '' }, PASSPHRASE), /damaged/);
});

test('a plain map is not mistaken for an encrypted one', async () => {
  await assert.rejects(() => decryptMap({ app: 'dia', batchId: 'ABCD2345' }, PASSPHRASE), /not an encrypted map/);
  assert.ok(!isEncryptedEnvelope({ app: 'dia' }));
});

test('an empty passphrase is refused', async () => {
  await assert.rejects(() => encryptMap(PLAINTEXT, ''), /passphrase is required/);
});

test('the verified encrypt path proves the file can be reopened', async () => {
  const envelope = await encryptMapVerified(PLAINTEXT, PASSPHRASE);
  assert.equal(await decryptMap(envelope, PASSPHRASE), PLAINTEXT);
});
