import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DeclarativeNetRequestAPI } from '../src/browser/api/declarative-net-request'
import { WebRequestAPI } from '../src/browser/api/web-request'

describe('chrome.declarativeNetRequest parity (Chrome MV3 static rulesets)', () => {
  const createCtx = () => {
    const handlers = new Map<string, Function>()
    const sessionExtensions = new EventEmitter() as any
    sessionExtensions.getAllExtensions = () => []
    sessionExtensions.on = sessionExtensions.addListener.bind(sessionExtensions)
    const ctx: any = {
      router: {
        apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
        sendEvent: () => undefined,
        sendEventForEachListener: () => undefined,
        broadcastEvent: () => undefined,
        setPermissionResolver: () => null,
      },
      session: { extensions: sessionExtensions },
      store: {
        getTabIdForWebContentsId: () => 1,
        getWindowIdForWebContentsId: () => 11,
        getDocumentId: () => 'doc-1',
      },
    }
    return { ctx, handlers }
  }

  const ext = (id = 'ext-dnr') => ({
    extension: {
      id,
      manifest: { permissions: ['declarativeNetRequest'] },
    },
  })

  it('honors domainType thirdParty for ping', async () => {
    const { ctx, handlers } = createCtx()
    const dnr = new DeclarativeNetRequestAPI(ctx)
    await handlers.get('declarativeNetRequest.updateDynamicRules')!(ext(), {
      addRules: [
        {
          id: 2,
          priority: 102,
          action: { type: 'block' },
          condition: {
            domainType: 'thirdParty',
            resourceTypes: ['ping'],
            urlFilter: '||tracker.example^',
          },
        },
      ],
    })

    expect(
      dnr.evaluateOnBeforeRequest({
        url: 'https://tracker.example/beacon',
        method: 'POST',
        tabId: 1,
        type: 'ping',
        initiator: 'https://page.example/',
      }),
    ).to.deep.equal({ cancel: true })

    expect(
      dnr.evaluateOnBeforeRequest({
        url: 'https://tracker.example/beacon',
        method: 'POST',
        tabId: 1,
        type: 'ping',
        initiator: 'https://www.tracker.example/',
      }),
    ).to.equal(null)
  })

  it('blocks same-registrable-domain subresources when rules match (no Chrome-inaccurate same-site skip)', async () => {
    const { ctx, handlers } = createCtx()
    const dnr = new DeclarativeNetRequestAPI(ctx)
    await handlers.get('declarativeNetRequest.updateDynamicRules')!(ext(), {
      addRules: [
        {
          id: 10,
          priority: 1,
          action: { type: 'block' },
          condition: { urlFilter: '||example.com^/track' },
        },
      ],
    })

    expect(
      dnr.evaluateOnBeforeRequest({
        url: 'https://example.com/track?v=1',
        method: 'GET',
        tabId: 1,
        type: 'xmlhttprequest',
        initiator: 'https://example.com/page',
      }),
    ).to.deep.equal({ cancel: true })
  })

  it('maps Electron ping to DNR resource type through webRequest bridge', async () => {
    const { ctx, handlers } = createCtx()
    const dnr = new DeclarativeNetRequestAPI(ctx)
    const web = new WebRequestAPI(ctx, dnr)

    await handlers.get('declarativeNetRequest.updateDynamicRules')!(ext(), {
      addRules: [
        {
          id: 3,
          priority: 2,
          action: { type: 'block' },
          condition: {
            resourceTypes: ['ping'],
            urlFilter: '||beacon.example^',
          },
        },
      ],
    })

    const res = await web.notifyOnBeforeRequest({
      id: 'r1',
      url: 'https://beacon.example/p',
      method: 'POST',
      resourceType: 'ping',
      webContentsId: 1,
      frameId: 0,
      parentFrameId: -1,
      timestamp: Date.now(),
      referrer: 'https://origin.example/',
    } as any)

    expect(res).to.deep.equal({ cancel: true })
  })

  it('blocks via requestDomains rules indexed by hostname', async () => {
    const { ctx, handlers } = createCtx()
    const dnr = new DeclarativeNetRequestAPI(ctx)
    const blockedDomain = 'ads-tracker-chunk-test.example'

    await handlers.get('declarativeNetRequest.updateDynamicRules')!(ext(), {
      addRules: [
        {
          id: 9001,
          priority: 1,
          action: { type: 'block' },
          condition: {
            requestDomains: [blockedDomain, 'other-tracker.example'],
          },
        },
      ],
    })

    expect(
      dnr.evaluateOnBeforeRequest({
        url: `https://${blockedDomain}/pixel.gif`,
        method: 'GET',
        tabId: 1,
        type: 'image',
        initiator: 'https://news.example/',
      }),
    ).to.deep.equal({ cancel: true })

    expect(
      dnr.evaluateOnBeforeRequest({
        url: 'https://allowed-cdn.example/asset.js',
        method: 'GET',
        tabId: 1,
        type: 'script',
        initiator: 'https://news.example/',
      }),
    ).to.equal(null)
  })

  it('updateStaticRules disables rules from a loaded static ruleset', async () => {
    const { ctx, handlers } = createCtx()
    const sessionExtensions = ctx.session.extensions as EventEmitter
    const dnr = new DeclarativeNetRequestAPI(ctx)
    const extensionId = 'ext-static-rules'

    const dir = mkdtempSync(join(tmpdir(), 'pce-dnr-static-'))
    writeFileSync(
      join(dir, 'rules.json'),
      JSON.stringify([
        {
          id: 1,
          priority: 1,
          action: { type: 'block' },
          condition: { urlFilter: '||static-disabled.example^' },
        },
      ]),
    )

    const extension = {
      id: extensionId,
      path: dir,
      manifest: {
        manifest_version: 3,
        permissions: ['declarativeNetRequest'],
        declarative_net_request: {
          rule_resources: [{ id: 'testset', enabled: false, path: 'rules.json' }],
        },
      },
    }

    sessionExtensions.emit('extension-loaded', null, extension)

    const probe = {
      url: 'https://static-disabled.example/track',
      method: 'GET',
      tabId: 1,
      type: 'xmlhttprequest',
      initiator: 'https://page.example/',
    }

    await handlers.get('declarativeNetRequest.updateEnabledRulesets')!(ext(extensionId), {
      enableRulesetIds: ['testset'],
    })

    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (dnr.evaluateOnBeforeRequest(probe)?.cancel === true) break
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(dnr.evaluateOnBeforeRequest(probe)).to.deep.equal({ cancel: true })

    await handlers.get('declarativeNetRequest.updateStaticRules')!(ext(extensionId), {
      rulesetId: 'testset',
      disableRuleIds: [1],
    })

    expect(
      dnr.evaluateOnBeforeRequest({
        url: 'https://static-disabled.example/track',
        method: 'GET',
        tabId: 1,
        type: 'xmlhttprequest',
        initiator: 'https://page.example/',
      }),
    ).to.equal(null)
  })

  it('matches ||opera.com^*pwngames using Chrome urlFilter semantics, not ABP', async () => {
    const { ctx, handlers } = createCtx()
    const dnr = new DeclarativeNetRequestAPI(ctx)
    await handlers.get('declarativeNetRequest.updateDynamicRules')!(ext('dnr-test'), {
      addRules: [
        {
          id: 4669,
          priority: 102,
          action: {
            type: 'redirect',
            redirect: { extensionPath: '/pages/redirect-protection/index.html' },
          },
          condition: {
            urlFilter: '||opera.com^*pwngames',
            resourceTypes: ['main_frame'],
          },
        },
      ],
    })

    const res = dnr.evaluateOnBeforeRequest({
      url: 'https://www.opera.com/computer/thanks?ni=eapgx&utm_source=PWNgames&edition=std-2',
      method: 'GET',
      tabId: 1,
      type: 'main_frame',
      initiator: 'https://thepiratebay.org/',
    })
    expect(res?.redirectUrl).to.equal(
      'chrome-extension://dnr-test/pages/redirect-protection/index.html',
    )
  })
})
