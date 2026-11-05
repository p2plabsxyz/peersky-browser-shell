import { expect } from 'chai'
import { EventEmitter } from 'node:events'

import { WebRequestAPI } from '../src/browser/api/web-request'

describe('chrome.webRequest', () => {
  const createHarness = () => {
    const handlers = new Map<string, Function>()
    const sentEvents: Array<{ extensionId: string; name: string; payload: any }> = []
    const sessionExtensions = new EventEmitter() as any
    sessionExtensions.on = sessionExtensions.addListener.bind(sessionExtensions)
    const ctx: any = {
      router: {
        apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
        sendEvent: (extensionId: string, name: string, payload: any) =>
          sentEvents.push({ extensionId, name, payload }),
      },
      session: { extensions: sessionExtensions },
      store: {
        getTabIdForWebContentsId: () => 1,
        getWindowIdForWebContentsId: () => 11,
        getDocumentId: () => 'doc-1',
      },
    }
    const api = new WebRequestAPI(ctx)
    return { api, handlers, sentEvents }
  }

  const extensionEvent = (extensionId: string, permissions: string[] = ['webRequest']) => ({
    extension: {
      id: extensionId,
      manifest: { permissions },
    },
  })

  const requestDetails = (url: string) =>
    ({
      id: `req-${Math.random().toString(16).slice(2)}`,
      url,
      method: 'GET',
      resourceType: 'script',
      webContentsId: 1,
      frameId: 0,
      parentFrameId: -1,
      timestamp: Date.now(),
      referrer: 'https://origin.example/',
    }) as any

  it('delivers non-blocking onBeforeRequest events', async () => {
    const { api, handlers, sentEvents } = createHarness()
    handlers.get('webRequest.addOnBeforeRequestListener')!(
      extensionEvent('ext-a'),
      { urls: ['*://*/*'] },
      [],
    )

    const result = await api.notifyOnBeforeRequest(requestDetails('https://example.com/asset.js'))
    expect(result).to.deep.equal({})
    expect(sentEvents).to.have.length(1)
    expect(sentEvents[0].name).to.equal('webRequest.onBeforeRequest')
    expect(sentEvents[0].payload.url).to.equal('https://example.com/asset.js')
  })

  it('supports blocking cancellation and redirect responses', async () => {
    const { api, handlers, sentEvents } = createHarness()
    handlers.get('webRequest.addOnBeforeRequestListener')!(
      extensionEvent('ext-a', ['webRequest', 'webRequestBlocking']),
      { urls: ['*://*/*'] },
      ['blocking'],
    )

    const cancelPromise = api.notifyOnBeforeRequest(requestDetails('https://example.com/blocked.js'))
    const cancelPayload = sentEvents[sentEvents.length - 1].payload
    handlers.get('webRequest.onBeforeRequest.response')!(
      extensionEvent('ext-a'),
      cancelPayload.requestId,
      cancelPayload.listenerId,
      { cancel: true },
    )
    expect(await cancelPromise).to.deep.equal({ cancel: true })

    const redirectPromise = api.notifyOnBeforeRequest(requestDetails('https://example.com/start.js'))
    const redirectPayload = sentEvents[sentEvents.length - 1].payload
    handlers.get('webRequest.onBeforeRequest.response')!(
      extensionEvent('ext-a'),
      redirectPayload.requestId,
      redirectPayload.listenerId,
      { redirectUrl: 'https://example.com/redirected.js' },
    )
    expect(await redirectPromise).to.deep.equal({
      redirectUrl: 'https://example.com/redirected.js',
    })
  })

  it('honors add/remove listener lifecycle for multiple listeners', async () => {
    const { api, handlers, sentEvents } = createHarness()
    handlers.get('webRequest.addOnBeforeRequestListener')!(
      extensionEvent('ext-a'),
      { urls: ['*://*/*'] },
      [],
    )
    handlers.get('webRequest.addOnBeforeRequestListener')!(
      extensionEvent('ext-b'),
      { urls: ['*://*/*'] },
      [],
    )

    await api.notifyOnBeforeRequest(requestDetails('https://example.com/one.js'))
    const firstEventTargets = sentEvents.map((e) => e.extensionId)
    expect(firstEventTargets).to.include.members(['ext-a', 'ext-b'])

    sentEvents.length = 0
    handlers.get('webRequest.removeOnBeforeRequestListener')!(extensionEvent('ext-a'))
    await api.notifyOnBeforeRequest(requestDetails('https://example.com/two.js'))

    expect(sentEvents.map((e) => e.extensionId)).to.deep.equal(['ext-b'])
  })

  // Chrome hands listeners headers as [{ name, value }] and takes changes back
  // the same way. Electron's { name: value | [values] } made a listener that
  // looked a header up throw (Browsec's details.responseHeaders.find).
  it('hands listeners headers as Chrome does', async () => {
    const { api, handlers, sentEvents } = createHarness()
    handlers.get('webRequest.addOnHeadersReceivedListener')!(
      extensionEvent('ext-a'),
      { urls: ['*://*/*'] },
      ['responseHeaders'],
    )
    handlers.get('webRequest.addOnSendHeadersListener')!(
      extensionEvent('ext-a'),
      { urls: ['*://*/*'] },
      ['requestHeaders'],
    )

    await api.notifyOnHeadersReceived({
      ...requestDetails('https://example.com/page'),
      statusCode: 200,
      responseHeaders: { 'Content-Type': ['text/html'], 'Set-Cookie': ['a=1', 'b=2'] },
    })
    await api.notifyOnSendHeaders({
      ...requestDetails('https://example.com/page'),
      requestHeaders: { 'User-Agent': 'PeerSky', Accept: '*/*' },
    })

    const received = sentEvents.find((e) => e.name === 'webRequest.onHeadersReceived')!.payload
    expect(received.responseHeaders).to.deep.equal([
      { name: 'Content-Type', value: 'text/html' },
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'Set-Cookie', value: 'b=2' },
    ])
    expect(received.responseHeaders.find((h: any) => h.name === 'Content-Type').value).to.equal(
      'text/html',
    )
    const sent = sentEvents.find((e) => e.name === 'webRequest.onSendHeaders')!.payload
    expect(sent.requestHeaders).to.deep.equal([
      { name: 'User-Agent', value: 'PeerSky' },
      { name: 'Accept', value: '*/*' },
    ])
  })

  it("takes a listener's changed headers back, replacing them all as Chrome does", async () => {
    const { api, handlers, sentEvents } = createHarness()
    const blocking = extensionEvent('ext-a', ['webRequest', 'webRequestBlocking'])
    handlers.get('webRequest.addOnHeadersReceivedListener')!(
      blocking,
      { urls: ['*://*/*'] },
      ['blocking', 'responseHeaders'],
    )
    handlers.get('webRequest.addOnBeforeSendHeadersListener')!(
      blocking,
      { urls: ['*://*/*'] },
      ['blocking', 'requestHeaders'],
    )

    const response = api.notifyOnHeadersReceived({
      ...requestDetails('https://example.com/page'),
      statusCode: 200,
      responseHeaders: { 'Content-Type': ['text/html'], 'X-Frame-Options': ['DENY'] },
    })
    let payload = sentEvents[sentEvents.length - 1].payload
    handlers.get('webRequest.onHeadersReceived.response')!(
      blocking,
      payload.requestId,
      payload.listenerId,
      {
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html' },
          { name: 'X-Added', value: 'yes' },
        ],
      },
    )
    expect(await response).to.deep.equal({
      responseHeaders: { 'Content-Type': ['text/html'], 'X-Added': ['yes'] },
    })

    const request = api.notifyOnBeforeSendHeaders({
      ...requestDetails('https://example.com/page'),
      requestHeaders: { Accept: '*/*', Cookie: 'c' },
    })
    payload = sentEvents[sentEvents.length - 1].payload
    handlers.get('webRequest.onBeforeSendHeaders.response')!(
      blocking,
      payload.requestId,
      payload.listenerId,
      {
        requestHeaders: [
          { name: 'Accept', value: 'a' },
          { name: 'Accept', value: 'b' },
          { name: 'X-Bin', binaryValue: [104, 105] },
        ],
      },
    )
    expect(await request).to.deep.equal({ requestHeaders: { Accept: 'a, b', 'X-Bin': 'hi' } })
  })

  it("still merges a listener that answers with Electron's form", async () => {
    const { api, handlers, sentEvents } = createHarness()
    const blocking = extensionEvent('ext-a', ['webRequest', 'webRequestBlocking'])
    handlers.get('webRequest.addOnHeadersReceivedListener')!(
      blocking,
      { urls: ['*://*/*'] },
      ['blocking', 'responseHeaders'],
    )

    const response = api.notifyOnHeadersReceived({
      ...requestDetails('https://example.com/page'),
      statusCode: 200,
      responseHeaders: { A: ['1'] },
    })
    const payload = sentEvents[sentEvents.length - 1].payload
    handlers.get('webRequest.onHeadersReceived.response')!(
      blocking,
      payload.requestId,
      payload.listenerId,
      { responseHeaders: { B: ['2'] } },
    )
    expect(await response).to.deep.equal({ responseHeaders: { A: ['1'], B: ['2'] } })
  })
})
