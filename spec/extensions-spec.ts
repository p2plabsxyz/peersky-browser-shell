import { expect } from 'chai'
import { session } from 'electron'
import { ElectronChromeExtensions } from '../'

describe('Extensions', () => {
  const testSession = session.fromPartition('test-extensions')
  const extensions = new ElectronChromeExtensions({
    license: 'internal-license-do-not-use' as any,
    session: testSession,
  })

  it('retrieves the instance with fromSession()', () => {
    expect(ElectronChromeExtensions.fromSession(testSession)).to.equal(extensions)
  })

  it('throws when two instances are created for session', () => {
    expect(() => {
      new ElectronChromeExtensions({
        license: 'internal-license-do-not-use' as any,
        session: testSession,
      })
    }).to.throw()
  })

  it('exposes focusTab for hosts that pin the page tab beside a side panel', () => {
    // Peersky (and other hosts) call this instead of reaching into private ctx.store.
    expect(extensions.focusTab).to.be.a('function')
  })
})
