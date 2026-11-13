import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import { ExtensionRouter } from '../src/browser/router'

// A page's requests reach an extension's service worker as a burst of
// webRequest events. Asking startWorkerForScope for each one queued them
// behind trips to the worker thread, about 90 ms a request on a busy page.
describe('router events to a service worker', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop'

  const setup = () => {
    const extensions = new EventEmitter() as any
    const extension = { id, manifest: { manifest_version: 3, permissions: ['webRequest'] } }
    extensions.getExtension = (wanted: string) => (wanted === id ? extension : undefined)
    const sent: any[][] = []
    const started: string[] = []
    const worker: any = { scope: `chrome-extension://${id}/`, versionId: 7, isDestroyed: () => false, send: (...args: any[]) => sent.push(args) }
    const serviceWorkers = new EventEmitter() as any
    serviceWorkers.getWorkerFromVersionID = (versionId: number) => (versionId === 7 ? worker : undefined)
    serviceWorkers.startWorkerForScope = async (scope: string) => {
      started.push(scope)
      return worker
    }
    const session: any = { extensions, serviceWorkers }
    const router = new ExtensionRouter(session, { addObserver() {} } as any)
    router.addListener({ type: 'service-worker', extensionId: id }, id, 'webRequest.onBeforeRequest', `chrome-extension://${id}/`)
    return { router, serviceWorkers, sent, started }
  }

  it('go straight to a worker that runs, at once and in order', () => {
    const { router, serviceWorkers, sent, started } = setup()
    serviceWorkers.emit('running-status-changed', { runningStatus: 'running', versionId: 7 })
    for (let i = 0; i < 3; i++) router.sendEvent(id, 'webRequest.onBeforeRequest', { requestId: String(i) })
    expect(sent.map((args) => args[1].requestId)).to.deep.equal(['0', '1', '2'])
    expect(started).to.deep.equal([])
  })

  it('start a worker that stopped, as before', async () => {
    const { router, serviceWorkers, sent, started } = setup()
    serviceWorkers.emit('running-status-changed', { runningStatus: 'running', versionId: 7 })
    serviceWorkers.emit('running-status-changed', { runningStatus: 'stopped', versionId: 7 })
    router.sendEvent(id, 'webRequest.onBeforeRequest', { requestId: '9' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(started).to.deep.equal([`chrome-extension://${id}/`])
    expect(sent.map((args) => args[1].requestId)).to.deep.equal(['9'])
  })
})
