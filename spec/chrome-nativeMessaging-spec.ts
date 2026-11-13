import { expect } from 'chai'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import * as cp from 'node:child_process'
import * as path from 'node:path'
import { app } from 'electron'
const exec = promisify(cp.exec)

import { useExtensionBrowser, useServer } from './hooks'
import { getExtensionId } from './crx-helpers'

// Native host build (SEA + postject) is slow/flaky on some Windows/CI setups; opt out with SKIP_NATIVE_MESSAGING=1.
// TODO: build crxtesthost on Linux (see script/native-messaging-host/build.js)
if (process.platform !== 'linux' && process.env.SKIP_NATIVE_MESSAGING !== '1') {
  describe('nativeMessaging', () => {
    const server = useServer()
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'rpc',
    })
    const hostApplication = 'com.crx.test'

    before(async function () {
      this.timeout(120e3)
      const extensionId = await getExtensionId('rpc')
      const pkgRoot = path.join(__dirname, '..')
      const buildScript = path.join(pkgRoot, 'script', 'native-messaging-host', 'build.js')
      const userData = app.getPath('userData')
      await exec(`node "${buildScript}" ${extensionId} "${userData}"`, {
        cwd: pkgRoot,
        maxBuffer: 20 * 1024 * 1024,
      })
    })

    describe('sendNativeMessage()', () => {
      it('sends and receives primitive value', async () => {
        const value = randomUUID()
        const result = await browser.crx.exec('runtime.sendNativeMessage', hostApplication, value)
        expect(result).to.equal(value)
      })

      it('sends and receives object', async () => {
        const value = { json: randomUUID(), wow: 'nice' }
        const result = await browser.crx.exec('runtime.sendNativeMessage', hostApplication, value)
        expect(result).to.deep.equal(value)
      })
    })
  })
}
