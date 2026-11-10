import { promises as fs } from 'node:fs'
import path from 'node:path'

// The OS encryption chrome.storage files are written with: Electron's
// safeStorage in the app, a stand-in in tests.
export interface StorageCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

// Refused while the OS key for an encrypted file cannot be had, as when the
// macOS keychain is locked or access to it was denied. The file is kept.
export class StorageLockedError extends Error {
  constructor() {
    super('Extension storage is locked right now. Nothing was changed.')
    this.name = 'StorageLockedError'
  }
}

/**
 * Chrome stores any key, '__proto__' and 'constructor' among them. They are
 * kept as plain data in an object with no prototype, so no key can reach one.
 */
export function sanitizeLoadedStorage(raw: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = Object.create(null)
  for (const k of Object.keys(raw)) {
    out[k] = raw[k]
  }
  return out
}

/**
 * Reads one extension's storage file. A missing or empty file is empty
 * storage.
 *
 * A file that cannot be read is never written over. Read as empty, the next
 * set wrote the extension's new data over it, and everything it had stored
 * was gone, in plain JSON if encryption was off for that run. So:
 * - encrypted while the OS key cannot be had right now: the read is refused
 *   and the file kept, and the next start that has the key reads it as before;
 * - not readable with the key there is now (the key was made again, or the
 *   file is damaged): the file is set aside under a new name, never deleted,
 *   and the extension starts from empty;
 * - not readable from the disk at all: the read is refused.
 */
export async function readStorageFile(
  filePath: string,
  crypto: StorageCrypto,
  label: string,
): Promise<Record<string, any>> {
  let buffer: Buffer
  try {
    buffer = await fs.readFile(filePath)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return Object.create(null)
    console.error(`Failed to load storage ${label} data`, err)
    throw new Error(`Extension storage could not be read (${err?.code || 'error'}). Nothing was changed.`)
  }

  // Written as plain JSON when OS encryption was not available, and as
  // encrypted bytes when it was. That can change between runs, so the format
  // is told from the file itself.
  const utf8 = buffer.toString('utf-8')
  const firstNonWs = utf8.match(/[^\s]/)?.[0]
  if (!firstNonWs) return Object.create(null)
  const plain = firstNonWs === '{' || firstNonWs === '['
  if (!plain && !crypto.isEncryptionAvailable()) {
    console.error(`Encrypted storage ${label} data cannot be opened right now; it is kept as it is`)
    throw new StorageLockedError()
  }

  try {
    const parsed = JSON.parse(plain ? utf8 : crypto.decryptString(buffer))
    return sanitizeLoadedStorage(
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, any>)
        : {},
    )
  } catch (err) {
    // A rename that fails throws, so the read fails and nothing is written.
    const aside = `${filePath}.unreadable-${Date.now()}`
    await fs.rename(filePath, aside)
    console.error(`Unreadable storage ${label} data set aside as ${path.basename(aside)}`, err)
    return Object.create(null)
  }
}

/** Writes one extension's storage file whole, through a temporary file. */
export async function writeStorageFile(
  filePath: string,
  data: Record<string, any>,
  crypto: StorageCrypto,
): Promise<void> {
  let json: string
  try {
    json = JSON.stringify(data)
  } catch (err) {
    throw new Error('Value is not JSON-serializable')
  }
  const content = crypto.isEncryptionAvailable() ? crypto.encryptString(json) : json
  const tmpPath = `${filePath}.tmp`
  await fs.writeFile(tmpPath, content, { mode: 0o600 })
  await fs.rename(tmpPath, filePath)
}
