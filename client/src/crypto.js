const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function fromBase64Url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function createRoomKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return { key, encoded: toBase64Url(raw) };
}

export async function importRoomKey(encoded) {
  if (!encoded) {
    throw new Error(
      'This invitation is missing its encryption key. Ask the creator for a fresh invite link.'
    );
  }

  const raw = fromBase64Url(encoded);

  if (raw.length !== 32) {
    throw new Error('The invitation encryption key is invalid.');
  }

  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptMessage(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(text)
  );

  return {
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    iv: toBase64Url(iv),
  };
}

export async function decryptMessage(key, packet) {
  const ciphertext = fromBase64Url(packet.ciphertext);
  const iv = fromBase64Url(packet.iv);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return decoder.decode(plaintext);
}

/**
 * Encrypt an image locally before uploading it.
 * The server receives only the encrypted bytes.
 *
 * Returns:
 * - ciphertext: Uint8Array for the binary upload
 * - key: base64url-encoded, per-image AES key
 * - iv: base64url-encoded AES-GCM nonce
 */
export async function encryptImage(file) {
  if (!(file instanceof Blob)) {
    throw new Error('Choose a valid image file.');
  }

  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  const plaintext = await file.arrayBuffer();

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  return {
    ciphertext: new Uint8Array(encrypted),
    key: toBase64Url(rawKey),
    iv: toBase64Url(iv),
  };
}

/**
 * Decrypt downloaded encrypted image bytes in the browser.
 * Accepts an ArrayBuffer or any ArrayBuffer-compatible byte view.
 */
export async function decryptImage(encryptedBytes, encodedKey, encodedIv) {
  if (!encodedKey || !encodedIv) {
    throw new Error('The image decryption information is missing.');
  }

  const rawKey = fromBase64Url(encodedKey);
  const iv = fromBase64Url(encodedIv);

  if (rawKey.length !== 32 || iv.length !== 12) {
    throw new Error('The image encryption information is invalid.');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  let ciphertext;

  if (encryptedBytes instanceof ArrayBuffer) {
    ciphertext = encryptedBytes;
  } else if (ArrayBuffer.isView(encryptedBytes)) {
    ciphertext = encryptedBytes.buffer.slice(
      encryptedBytes.byteOffset,
      encryptedBytes.byteOffset + encryptedBytes.byteLength
    );
  } else {
    throw new Error('The downloaded image data is invalid.');
  }

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
}
