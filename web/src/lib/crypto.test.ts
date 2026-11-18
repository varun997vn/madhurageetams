/**
 * Interop contract with build/mg/crypto.py.
 *
 * Runs the same vectors the Python suite runs, against Node's WebCrypto — which is the
 * same implementation the browser uses. A failure here means the site would ship
 * ciphertext the client cannot open, with no way to notice before deploy.
 */
import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import vectors from '../../../fixtures/crypto_vectors.json'

// Node exposes WebCrypto but not as a global in every version.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

const {
  base64ToBytes,
  bytesToBase64,
  deriveKeyBytes,
  importAesKey,
  keyCheckValue,
  openShard,
  suggestToken,
  WrongPasswordError,
  CorruptShardError,
} = await import('./crypto')

let keyBytes: Uint8Array
let key: CryptoKey

beforeAll(async () => {
  keyBytes = await deriveKeyBytes(
    vectors.password,
    base64ToBytes(vectors.salt),
    vectors.iterations,
  )
  key = await importAesKey(keyBytes)
})

describe('key derivation', () => {
  it('reproduces the fixture key', () => {
    expect(bytesToBase64(keyBytes)).toBe(vectors.derivedKey)
  })

  it('reproduces the key check value', async () => {
    expect(await keyCheckValue(keyBytes, base64ToBytes(vectors.salt))).toBe(vectors.kcv)
  })

  it('reproduces the suggestion proof-of-unlock token', async () => {
    expect(await suggestToken(keyBytes)).toBe(vectors.suggestToken)
  })

  it('produces a different KCV for a wrong password', async () => {
    const other = await deriveKeyBytes(
      'a completely different password',
      base64ToBytes(vectors.salt),
      vectors.iterations,
    )
    expect(await keyCheckValue(other, base64ToBytes(vectors.salt))).not.toBe(vectors.kcv)
  })
})

describe('container decryption', () => {
  for (const sample of vectors.samples) {
    it(`opens the "${sample.name}" sample`, async () => {
      const blob = base64ToBytes(sample.blob)
      if (sample.plaintext === '') {
        // The empty sample is not JSON; assert it decrypts rather than parses.
        await expect(openShard(key, sample.name, blob)).rejects.toThrow(SyntaxError)
        return
      }
      expect(await openShard(key, sample.name, blob)).toEqual(JSON.parse(sample.plaintext))
    })
  }

  it('rejects the wrong key with WrongPasswordError', async () => {
    const sample = vectors.samples[0]!
    const other = await importAesKey(
      await deriveKeyBytes('nope', base64ToBytes(vectors.salt), vectors.iterations),
    )
    await expect(openShard(other, sample.name, base64ToBytes(sample.blob))).rejects.toBeInstanceOf(
      WrongPasswordError,
    )
  })

  it('distinguishes a corrupt download from a wrong password', async () => {
    const sample = vectors.samples[0]!
    await expect(
      openShard(key, sample.name, base64ToBytes(sample.blob), 'deadbeef'),
    ).rejects.toBeInstanceOf(CorruptShardError)
  })

  it('rejects a bad magic', async () => {
    const blob = base64ToBytes(vectors.samples[0]!.blob)
    blob[0] = 'X'.charCodeAt(0)
    await expect(openShard(key, 'core', blob)).rejects.toBeInstanceOf(CorruptShardError)
  })

  it('rejects a truncated blob', async () => {
    const blob = base64ToBytes(vectors.samples[0]!.blob).slice(0, 10)
    await expect(openShard(key, 'core', blob)).rejects.toBeInstanceOf(CorruptShardError)
  })

  it('rejects tampered ciphertext', async () => {
    const blob = base64ToBytes(vectors.samples[0]!.blob)
    blob[vectors.container.headerLen] ^= 0xff
    await expect(openShard(key, 'core', blob)).rejects.toBeInstanceOf(WrongPasswordError)
  })
})
