/**
 * Unlock and shard decryption, using WebCrypto only.
 *
 * Container format (written by `build/mg/crypto.py`, pinned by
 * `fixtures/crypto_vectors.json`):
 *
 *   offset  0   4B   magic "MG01"
 *   offset  4   1B   version = 1
 *   offset  5   1B   flags (bit0 = payload is gzipped)
 *   offset  6   2B   reserved
 *   offset  8  12B   IV
 *   offset 20   ..   AES-256-GCM ciphertext || 16B tag
 *
 * Threat model, stated plainly: the site is a public URL and every ciphertext is
 * publicly downloadable, so an attacker brute-forces offline at their own hardware's
 * rate, unconstrained by anything here. The 600k PBKDF2 iterations only multiply their
 * per-guess cost by a constant. All real security comes from the entropy of a
 * CSPRNG-generated password.
 */

const MAGIC = 'MG01'
const HEADER_LEN = 20
const IV_OFFSET = 8
const IV_LEN = 12
const FLAG_GZIP = 0x01

export interface ShardEntry {
  name: string
  url: string
  bytes: number
  sha256: string
  plainSha256?: string
}

export interface Manifest {
  v: number
  built: string
  revision: string
  corpus: { songs: number }
  kdf: { alg: string; iterations: number; salt: string; keyLen: number }
  cipher: string
  container: string
  kcv: string
  shards: ShardEntry[]
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password')
    this.name = 'WrongPasswordError'
  }
}

export class CorruptShardError extends Error {
  constructor(name: string, detail: string) {
    super(`Could not load "${name}": ${detail}`)
    this.name = 'CorruptShardError'
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** PBKDF2-SHA256, mirroring hashlib.pbkdf2_hmac on the build side. */
export async function deriveKeyBytes(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * Short digest of the key, so a wrong password fails in under a millisecond with no
 * network I/O. This leaks nothing an attacker did not already have: the GCM tag on a
 * publicly downloadable blob already lets them verify guesses offline.
 */
export async function keyCheckValue(keyBytes: Uint8Array, salt: Uint8Array): Promise<string> {
  const input = new Uint8Array(keyBytes.length + salt.length + 6)
  input.set(keyBytes, 0)
  input.set(salt, keyBytes.length)
  input.set(new TextEncoder().encode('mg-kcv'), keyBytes.length + salt.length)
  const digest = await crypto.subtle.digest('SHA-256', input as BufferSource)
  return bytesToBase64(new Uint8Array(digest).slice(0, 8))
}

export async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['decrypt'])
}

/** Also used for the unencrypted native-script shards, which are gzipped but not sealed. */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BufferSource]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Decrypt one container blob.
 *
 * `expectedSha256` is verified *before* decryption on purpose. A bare GCM
 * `OperationError` cannot distinguish "wrong key" from "truncated or corrupted
 * response", and conflating those two is the single biggest source of unexplainable
 * failures for a site like this.
 */
export async function openShard(
  key: CryptoKey,
  name: string,
  blob: Uint8Array,
  expectedSha256?: string,
): Promise<unknown> {
  if (blob.length < HEADER_LEN + 16) {
    throw new CorruptShardError(name, 'response too short to be a container')
  }
  const magic = new TextDecoder().decode(blob.slice(0, 4))
  if (magic !== MAGIC) {
    throw new CorruptShardError(name, `bad magic "${magic}" (expected ${MAGIC})`)
  }
  if (blob[4] !== 1) {
    throw new CorruptShardError(name, `unsupported container version ${blob[4]}`)
  }

  if (expectedSha256) {
    const actual = toHex(await crypto.subtle.digest('SHA-256', blob as BufferSource))
    if (actual !== expectedSha256) {
      throw new CorruptShardError(name, 'checksum mismatch — the download was incomplete or altered')
    }
  }

  const gzipped = (blob[5]! & FLAG_GZIP) !== 0
  const iv = blob.slice(IV_OFFSET, IV_OFFSET + IV_LEN)
  const body = blob.slice(HEADER_LEN)

  let plain: Uint8Array
  try {
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 },
      key,
      body as BufferSource,
    )
    plain = new Uint8Array(buf)
  } catch {
    // The checksum already passed, so this can only be the wrong key.
    throw new WrongPasswordError()
  }

  const json = gzipped ? await gunzip(plain) : plain
  return JSON.parse(new TextDecoder().decode(json))
}

/** True when the page can actually use WebCrypto (needs HTTPS or localhost). */
export function isSecureContextAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'
}
