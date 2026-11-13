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

// The toolbar's own calls (browserAction.activate and the rest) come from the
// host's window. An extension page reaches the router too, with an id of its
// choosing, and the click it could fake grants activeTab.
describe('router calls', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop'
  const other = 'ponmlkjihgfedcbaponmlkjihgfedcba'

  const setup = () => {
    const extensions = new EventEmitter() as any
    const loaded: Record<string, any> = {
      [id]: { id, manifest: { manifest_version: 3, permissions: [] } },
      [other]: { id: other, manifest: { manifest_version: 3, permissions: ['management'] } },
    }
    extensions.getExtension = (wanted: string) => loaded[wanted]
    const session: any = { extensions, serviceWorkers: new EventEmitter() }
    const router = new ExtensionRouter(session, { addObserver() {} } as any)
    const calls: any[] = []
    const handle = router.apiHandler()
    handle('browserAction.activate', (event: any, ...args: any[]) => calls.push(['activate', event.extension?.id, ...args]), {
      allowRemote: true,
      extensionContext: false,
    })
    handle('tabs.query', (event: any) => calls.push(['query', event.extension.id]))
    handle('management.getAll', (event: any) => calls.push(['getAll', event.extension.id]))
    handle('management.getSelf', (event: any) => calls.push(['getSelf', event.extension.id]), { permission: null })
    const from = (url: string) => ({ type: 'frame', sender: { session }, senderFrame: { url } }) as any
    const worker = (scope: string) => ({ type: 'service-worker', session, serviceWorker: { scope } }) as any
    return { router, calls, from, worker }
  }
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error) => (error as Error).message,
    )

  it("refuses the toolbar's calls from an extension's page or worker, whatever id it passes", async () => {
    const { router, calls, from, worker } = setup()
    const page = from(`chrome-extension://${id}/popup.html`)
    const activate = { extensionId: other, tabId: 1, eventType: 'click' }
    expect(await refusal(router.onExtensionMessage(page, '', 'browserAction.activate', {}, activate))).to.equal(
      'browserAction.activate is not available to extensions',
    )
    expect(await refusal(router.onExtensionMessage(page, undefined, 'browserAction.activate', {}, activate))).to.equal(
      'browserAction.activate is not available to extensions',
    )
    expect(
      await refusal(router.onExtensionMessage(worker(`chrome-extension://${id}/`), id, 'browserAction.activate', {}, activate)),
    ).to.equal('browserAction.activate is not available to extensions')
    expect(calls).to.deep.equal([])
  })

  it('lets the host window make the toolbar calls', async () => {
    const { router, calls, from } = setup()
    await router.onExtensionMessage(from('file:///app/index.html'), undefined, 'browserAction.activate', {}, { extensionId: id })
    expect(calls).to.deep.equal([['activate', undefined, { extensionId: id }]])
  })

  it('has an extension call only as itself', async () => {
    const { router, calls, from } = setup()
    const page = from(`chrome-extension://${id}/page.html`)
    expect(await refusal(router.onExtensionMessage(page, other, 'tabs.query', {}, {}))).to.equal(
      'tabs.query was sent from outside the extension',
    )
    expect(await refusal(router.onExtensionMessage(page, '', 'tabs.query', {}, {}))).to.equal(
      'tabs.query was sent from outside the extension',
    )
    await router.onExtensionMessage(page, id, 'tabs.query', {}, {})
    expect(calls).to.deep.equal([['query', id]])
  })

  // As in Chrome: every extension may call getSelf, and only one with the
  // management permission sees and changes the others.
  it('holds chrome.management to the management permission, all but getSelf', async () => {
    const { router, calls, from } = setup()
    const without = from(`chrome-extension://${id}/page.html`)
    expect(await refusal(router.onExtensionMessage(without, id, 'management.getAll', {}))).to.equal(
      "'management.getAll' requires the 'management' permission.",
    )
    await router.onExtensionMessage(without, id, 'management.getSelf', {})
    await router.onExtensionMessage(from(`chrome-extension://${other}/page.html`), other, 'management.getAll', {})
    expect(calls).to.deep.equal([
      ['getSelf', id],
      ['getAll', other],
    ])
  })
})
