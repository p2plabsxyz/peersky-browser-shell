import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import { ExtensionRouter } from '../src/browser/router'

// An extension's page names the events it listens to. It could rename one of
// its own event objects (`chrome.runtime.onInstalled.name = 'cookies.onChanged'`)
// to hear an API it has no permission for, so the router decides.
describe('router event subscriptions', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop'
  const page = `chrome-extension://${id}/page.html`

  const setup = (permissions: string[]) => {
    const extensions = new EventEmitter() as any
    const extension = { id, manifest: { manifest_version: 3, permissions } }
    extensions.getExtension = (wanted: string) => (wanted === id ? extension : undefined)
    const session: any = { extensions, serviceWorkers: new EventEmitter() }
    const router = new ExtensionRouter(session, { addObserver() {} } as any)
    const sent: any[][] = []
    const host: any = {
      id: 1,
      isDestroyed: () => false,
      send: (...args: any[]) => sent.push(args),
      once() {},
      getURL: () => page,
    }
    return { router, host, sent }
  }

  it('ignores a listener for an event the extension has no permission for', () => {
    const { router, host, sent } = setup(['storage'])
    router.addListener({ type: 'frame', extensionId: id, host }, id, 'cookies.onChanged', page)
    router.broadcastEvent('cookies.onChanged', { removed: false })
    expect(sent).to.deep.equal([])
  })

  it('delivers an event the extension holds the permission for', () => {
    const { router, host, sent } = setup(['storage'])
    router.addListener({ type: 'frame', extensionId: id, host }, id, 'storage.onChanged', page)
    router.broadcastEvent('storage.onChanged', {}, 'local')
    expect(sent).to.have.length(1)
    expect(sent[0][0]).to.equal('crx-storage.onChanged')
  })

  it('delivers events that need no permission', () => {
    const { router, host, sent } = setup([])
    router.addListener({ type: 'frame', extensionId: id, host }, id, 'tabs.onCreated', page)
    router.broadcastEvent('tabs.onCreated', { id: 1 })
    expect(sent).to.have.length(1)
  })

  it('ignores a listener sent from outside the extension', () => {
    const { router, host, sent } = setup(['storage'])
    router.addListener({ type: 'frame', extensionId: id, host }, id, 'storage.onChanged', 'https://example.com/')
    router.broadcastEvent('storage.onChanged', {}, 'local')
    expect(sent).to.deep.equal([])
  })

  it('keeps management events for extensions with the management permission', () => {
    const { router, host, sent } = setup([])
    router.addListener({ type: 'frame', extensionId: id, host }, id, 'management.onUninstalled', page)
    router.broadcastEvent('management.onUninstalled', 'other')
    expect(sent).to.deep.equal([])
  })
})
