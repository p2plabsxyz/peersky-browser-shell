#!/usr/bin/env node

const { promises: fs } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const util = require('node:util')
const cp = require('node:child_process')
const exec = util.promisify(cp.exec)

const outDir = path.join(__dirname, '.')
const exeName = `crxtesthost${process.platform === 'win32' ? '.exe' : ''}`
const seaBlobName = 'crxtesthost.blob'

async function createSEA() {
  await fs.rm(path.join(outDir, seaBlobName), { force: true })
  await fs.rm(path.join(outDir, exeName), { force: true })

  await exec('node --experimental-sea-config sea-config.json', { cwd: outDir })
  await fs.cp(process.execPath, path.join(outDir, exeName))

  if (process.platform === 'darwin') {
    await exec(`codesign --remove-signature ${exeName}`, { cwd: outDir })
  }

  console.info(`Building ${exeName}…`)
  const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`
  const buildCmd = [
    'npx postject',
    quote(exeName),
    'NODE_SEA_BLOB',
    quote(seaBlobName),
    '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name NODE_SEA'] : []),
  ]
  await exec(buildCmd.join(' '), { cwd: outDir })

  if (process.platform === 'darwin') {
    await exec(`codesign --sign - ${exeName}`, { cwd: outDir })
  }
}

async function installConfig(extensionIds, userDataDir) {
  console.info(`Installing config…`)

  const hostName = 'com.crx.test'
  const manifest = {
    name: hostName,
    description: 'electron-chrome-extensions test',
    path: path.join(outDir, exeName),
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  }

  const writeManifest = async (manifestPath) => {
    await fs.mkdir(manifestPath, { recursive: true })
    const filePath = path.join(manifestPath, `${hostName}.json`)
    const data = Buffer.from(JSON.stringify(manifest, null, 2))
    await fs.writeFile(filePath, data)
    return filePath
  }

  // The test runner gives each run its own userData folder, and the host is
  // looked up in <userData>/NativeMessagingHosts.
  if (userDataDir && process.platform !== 'win32') {
    await writeManifest(path.join(userDataDir, 'NativeMessagingHosts'))
    return
  }

  switch (process.platform) {
    case 'darwin': {
      const manifestDir = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Electron',
        'NativeMessagingHosts',
      )
      await writeManifest(manifestDir)
      break
    }
    case 'win32': {
      const manifestDir = path.join(
        os.homedir(),
        'AppData',
        'Roaming',
        'Electron',
        'NativeMessagingHosts',
      )
      const manifestPath = await writeManifest(manifestDir)
      const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
      await exec(`reg add "${registryKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, {
        stdio: 'inherit',
      })
      break
    }
    default:
      return
  }
}

async function main() {
  const extensionIdsArg = process.argv[2]
  if (!extensionIdsArg) {
    console.error('Must pass in csv of allowed extension IDs')
    process.exit(1)
  }

  const extensionIds = extensionIdsArg.split(',')
  await createSEA()
  await installConfig(extensionIds, process.argv[3])
}

main()
