import { expect } from 'chai'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readStorageFile,
  StorageCrypto,
  StorageLockedError,
  writeStorageFile,
} from '../src/browser/api/storage-file'

// A stand-in for safeStorage: "enc:" and the text backwards, so a written
// file is never plain JSON, and a key can be swapped or taken away.
function fakeCrypto(key = 'k1') {
  const crypto = {
    available: true,
    key,
    isEncryptionAvailable: () => crypto.available,
    encryptString: (text: string) => Buffer.from(`enc:${crypto.key}:${[...text].reverse().join('')}`),
    decryptString: (buffer: Buffer) => {
      const value = buffer.toString('utf-8')
      const prefix = `enc:${crypto.key}:`
      if (!value.startsWith(prefix)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return [...value.slice(prefix.length)].reverse().join('')
    },
  }
  return crypto as typeof crypto & StorageCrypto
}

// An unreadable storage file read as empty, and the next set wrote over it,
// so everything the extension had stored was lost. It is kept now.
describe('chrome.storage files that cannot be read', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-file-spec-'))
    file = path.join(dir, 'ext.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const asideFiles = async () => (await fs.readdir(dir)).filter((name) => name.startsWith('ext.json.unreadable-'))

  it('reads back what it wrote, encrypted', async () => {
    const crypto = fakeCrypto()
    await writeStorageFile(file, { count: 2, list: [1, 2] }, crypto)
    expect((await fs.readFile(file, 'utf-8')).startsWith('enc:k1:')).to.equal(true)
    expect(await readStorageFile(file, crypto, 'local')).to.deep.equal({ count: 2, list: [1, 2] })
  })

  it('is empty when there is no file yet, or an empty one', async () => {
    const crypto = fakeCrypto()
    expect(await readStorageFile(file, crypto, 'local')).to.deep.equal({})
    await fs.writeFile(file, '  \n')
    expect(await readStorageFile(file, crypto, 'local')).to.deep.equal({})
  })

  it('refuses to read an encrypted file while the key cannot be had, and keeps it for the next start', async () => {
    const crypto = fakeCrypto()
    await writeStorageFile(file, { count: 2 }, crypto)
    const before = await fs.readFile(file)

    crypto.available = false
    let error: unknown
    try {
      await readStorageFile(file, crypto, 'local')
    } catch (err) {
      error = err
    }
    expect(error).to.be.instanceOf(StorageLockedError)
    expect((await fs.readFile(file)).equals(before)).to.equal(true)
    expect(await asideFiles()).to.deep.equal([])

    crypto.available = true
    expect(await readStorageFile(file, crypto, 'local')).to.deep.equal({ count: 2 })
  })

  it('sets aside a file the key there is now cannot open, and starts from empty', async () => {
    const crypto = fakeCrypto('old')
    await writeStorageFile(file, { count: 2 }, crypto)
    const before = await fs.readFile(file)

    crypto.key = 'new'
    expect(await readStorageFile(file, crypto, 'local')).to.deep.equal({})
    const aside = await asideFiles()
    expect(aside).to.have.length(1)
    expect((await fs.readFile(path.join(dir, aside[0]))).equals(before)).to.equal(true)

    // The extension goes on with a file of its own, and the old one stays.
    await writeStorageFile(file, { count: 1 }, crypto)
    expect(await readStorageFile(file, crypto, 'local')).to.deep.equal({ count: 1 })
    expect(await asideFiles()).to.have.length(1)
    crypto.key = 'old'
    expect(await readStorageFile(path.join(dir, aside[0]), crypto, 'local')).to.deep.equal({ count: 2 })
  })

  it('sets aside a damaged plain file rather than writing over it', async () => {
    const crypto = fakeCrypto()
    await fs.writeFile(file, '{"count": 2')
    expect(await readStorageFile(file, crypto, 'sync')).to.deep.equal({})
    expect(await asideFiles()).to.have.length(1)
  })

  it('refuses a file that cannot be read from the disk at all', async () => {
    const crypto = fakeCrypto()
    await fs.mkdir(file)
    let error: unknown
    try {
      await readStorageFile(file, crypto, 'local')
    } catch (err) {
      error = err
    }
    expect(error).to.be.instanceOf(Error)
    expect((await fs.stat(file)).isDirectory()).to.equal(true)
    expect(await asideFiles()).to.deep.equal([])
  })

  it('still reads and writes plain JSON where there is no OS encryption, as on Linux without a keyring', async () => {
    const crypto = fakeCrypto()
    crypto.available = false
    await writeStorageFile(file, { count: 1 }, crypto)
    expect(await fs.readFile(file, 'utf-8')).to.equal('{"count":1}')
    expect(await readStorageFile(file, crypto, 'local')).to.deep.equal({ count: 1 })
    // Encryption that comes later takes the plain file as it is.
    crypto.available = true
    expect(await readStorageFile(file, crypto, 'local')).to.deep.equal({ count: 1 })
  })

  it('drops keys that could reach the prototype', async () => {
    const crypto = fakeCrypto()
    await fs.writeFile(file, '{"__proto__": {"polluted": true}, "constructor": 1, "ok": 1}')
    const data = await readStorageFile(file, crypto, 'local')
    expect(data).to.deep.equal({ ok: 1 })
    expect(({} as any).polluted).to.equal(undefined)
  })
})
