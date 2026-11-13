import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The font families installed on this machine, read from the font files'
 * own name tables, as chrome.fontSettings.getFontList returns them. Electron
 * has no font list of its own. Everything here is async and read once.
 */

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i
const MAX_FILES = 6000
const MAX_DEPTH = 6
const CONCURRENCY = 16

function fontDirectories(): string[] {
  const home = os.homedir()
  switch (process.platform) {
    case 'darwin':
      return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')]
    case 'win32': {
      const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
      const local = process.env.LOCALAPPDATA
      return [path.join(windir, 'Fonts'), ...(local ? [path.join(local, 'Microsoft', 'Windows', 'Fonts')] : [])]
    }
    default:
      return [
        '/usr/share/fonts',
        '/usr/local/share/fonts',
        path.join(home, '.fonts'),
        path.join(home, '.local', 'share', 'fonts'),
      ]
  }
}

async function findFontFiles(): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if ((entry.isFile() || entry.isSymbolicLink()) && FONT_FILE.test(entry.name)) files.push(full)
    }
  }
  for (const dir of fontDirectories()) await walk(dir, 0)
  return files
}

const decodeUtf16BE = (buf: Buffer) => {
  const swapped = Buffer.alloc(buf.length - (buf.length % 2))
  for (let i = 0; i + 1 < buf.length; i += 2) {
    swapped[i] = buf[i + 1]
    swapped[i + 1] = buf[i]
  }
  return swapped.toString('utf16le')
}

async function readAt(fh: import('node:fs/promises').FileHandle, position: number, length: number) {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

/** The family names of the font (or fonts, in a collection) at `offset`. */
async function familyNames(fh: import('node:fs/promises').FileHandle, offset: number): Promise<string | undefined> {
  const header = await readAt(fh, offset, 12)
  if (header.length < 12) return undefined
  const numTables = header.readUInt16BE(4)
  if (numTables === 0 || numTables > 512) return undefined
  const dir = await readAt(fh, offset + 12, numTables * 16)
  let nameOffset = -1
  let nameLength = 0
  for (let i = 0; i + 16 <= dir.length; i += 16) {
    if (dir.toString('latin1', i, i + 4) === 'name') {
      nameOffset = dir.readUInt32BE(i + 8)
      nameLength = dir.readUInt32BE(i + 12)
      break
    }
  }
  if (nameOffset < 0 || nameLength < 6 || nameLength > 1 << 20) return undefined
  const table = await readAt(fh, nameOffset, nameLength)
  if (table.length < 6) return undefined
  const count = table.readUInt16BE(2)
  const stringOffset = table.readUInt16BE(4)
  // A typographic family (16) groups weights the way the system's own font
  // menus do; Windows lists the older family names (1).
  const wanted = process.platform === 'darwin' ? [16, 1] : [1, 16]
  let best: { rank: number; name: string } | undefined
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12
    if (at + 12 > table.length) break
    const platform = table.readUInt16BE(at)
    const encoding = table.readUInt16BE(at + 2)
    const language = table.readUInt16BE(at + 4)
    const nameId = table.readUInt16BE(at + 6)
    const length = table.readUInt16BE(at + 8)
    const start = stringOffset + table.readUInt16BE(at + 10)
    const idRank = wanted.indexOf(nameId)
    if (idRank < 0 || start + length > table.length) continue
    let name: string | undefined
    let langRank = 2
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      name = decodeUtf16BE(table.subarray(start, start + length))
      langRank = language === 0x409 ? 0 : 1
    } else if (platform === 0) {
      name = decodeUtf16BE(table.subarray(start, start + length))
      langRank = 1
    } else if (platform === 1 && encoding === 0) {
      name = table.toString('latin1', start, start + length)
      langRank = language === 0 ? 0 : 2
    }
    if (!name) continue
    const rank = idRank * 10 + langRank
    if (!best || rank < best.rank) best = { rank, name: name.trim() }
  }
  return best?.name
}

async function familiesInFile(file: string): Promise<string[]> {
  let fh: import('node:fs/promises').FileHandle | undefined
  try {
    fh = await fs.open(file, 'r')
    const head = await readAt(fh, 0, 16)
    if (head.length < 12) return []
    const offsets =
      head.toString('latin1', 0, 4) === 'ttcf'
        ? await (async () => {
            const n = Math.min(head.readUInt32BE(8), 64)
            const table = await readAt(fh!, 12, n * 4)
            const out: number[] = []
            for (let i = 0; i + 4 <= table.length; i += 4) out.push(table.readUInt32BE(i))
            return out
          })()
        : [0]
    const names: string[] = []
    for (const offset of offsets) {
      const name = await familyNames(fh, offset)
      if (name) names.push(name)
    }
    return names
  } catch {
    return []
  } finally {
    await fh?.close().catch(() => {})
  }
}

let cached: Promise<chrome.fontSettings.FontName[]> | undefined

/** Installed font families, sorted by name, each as { fontId, displayName }. */
export function getInstalledFonts(): Promise<chrome.fontSettings.FontName[]> {
  if (!cached) {
    cached = (async () => {
      const files = await findFontFiles()
      const families = new Set<string>()
      for (let i = 0; i < files.length; i += CONCURRENCY) {
        const batch = await Promise.all(files.slice(i, i + CONCURRENCY).map(familiesInFile))
        for (const names of batch) {
          // Names starting with a dot are the system's hidden UI fonts.
          for (const name of names) if (name && !name.startsWith('.') && name.length < 256) families.add(name)
        }
      }
      return [...families]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ fontId: name, displayName: name }))
    })().catch(() => [])
  }
  return cached
}
