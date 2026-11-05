import { expect } from 'chai'

import { ProxyAPI } from '../src/browser/api/proxy'

describe('chrome.proxy', () => {
  const createHarness = () => {
    const handlers = new Map<string, Function>()
    const setProxyCalls: any[] = []
    const onChangeCalls: Array<{ extensionId: string; details: any }> = []

    const ctx: any = {
      session: {
        setProxy: async (cfg: any) => {
          setProxyCalls.push(cfg)
        },
      },
      router: {
        apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
        sendEventForEachListener: (eventName: string, mapArgs: (extensionId: string) => any[]) => {
          if (eventName !== 'proxy.settings.onChange') return
          // Simulate two listeners: the controlling extension and some other extension.
          for (const extensionId of ['ext-1', 'ext-2']) {
            const [details] = mapArgs(extensionId)
            onChangeCalls.push({ extensionId, details })
          }
        },
      },
    }

    new ProxyAPI(ctx)

    const evt = (id: string) => ({ extension: { id } })
    return { handlers, setProxyCalls, onChangeCalls, evt }
  }

  it('settings.get returns system config and controllable state', async () => {
    const { handlers, evt } = createHarness()
    const out = await handlers.get('proxy.settings.get')!(evt('ext-1'))
    expect(out.value).to.deep.equal({ mode: 'system' })
    expect(out.levelOfControl).to.equal('controllable_by_this_extension')
    expect(out.incognitoSpecific).to.equal(false)
  })

  it('settings.set applies config and updates levelOfControl', async () => {
    const { handlers, setProxyCalls, onChangeCalls, evt } = createHarness()
    await handlers.get('proxy.settings.set')!(evt('ext-1'), { value: { mode: 'direct' } })

    expect(setProxyCalls[0]).to.deep.equal({ mode: 'direct' })
    // onChange is delivered per-listener; ensure controlling extension sees "controlled_by_this_extension".
    const controlling = onChangeCalls.find((c) => c.extensionId === 'ext-1')!.details
    const other = onChangeCalls.find((c) => c.extensionId === 'ext-2')!.details
    expect(controlling.value.mode).to.equal('direct')
    expect(controlling.levelOfControl).to.equal('controlled_by_this_extension')
    expect(other.levelOfControl).to.equal('controlled_by_other_extensions')

    const out = await handlers.get('proxy.settings.get')!(evt('ext-1'))
    expect(out.levelOfControl).to.equal('controlled_by_this_extension')
  })

  it('settings.clear resets to system only for controlling extension', async () => {
    const { handlers, setProxyCalls, onChangeCalls, evt } = createHarness()
    await handlers.get('proxy.settings.set')!(evt('ext-1'), { value: { mode: 'direct' } })
    onChangeCalls.length = 0

    await handlers.get('proxy.settings.clear')!(evt('ext-2'))
    expect(setProxyCalls).to.have.length(1) // clear ignored

    await handlers.get('proxy.settings.clear')!(evt('ext-1'))
    expect(setProxyCalls[1]).to.deep.equal({ mode: 'system' })
    const controlling = onChangeCalls.find((c) => c.extensionId === 'ext-1')!.details
    expect(controlling.value.mode).to.equal('system')
    expect(controlling.levelOfControl).to.equal('controllable_by_this_extension')
  })

  it('fixed_servers maps to Electron proxyRules / bypass list', async () => {
    const { handlers, setProxyCalls, evt } = createHarness()
    await handlers.get('proxy.settings.set')!(evt('ext-1'), {
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port: 8888 },
          bypassList: ['localhost', '127.0.0.1'],
        },
      },
    })

    expect(setProxyCalls[0]).to.deep.equal({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:8888',
      proxyBypassRules: 'localhost,127.0.0.1',
    })
  })

  // Without a scheme on each server, Chromium took an HTTPS proxy for a plain
  // HTTP one and SOCKS5 for SOCKS4.
  it('fixed_servers keeps each proxy server its own scheme', async () => {
    const rulesFor = async (rules: chrome.proxy.ProxyRules) => {
      const { handlers, setProxyCalls, evt } = createHarness()
      await handlers.get('proxy.settings.set')!(evt('ext-1'), {
        value: { mode: 'fixed_servers', rules },
      })
      return setProxyCalls[0].proxyRules
    }

    expect(await rulesFor({ singleProxy: { scheme: 'https', host: 'vpn.example', port: 443 } })).to.equal(
      'https://vpn.example:443',
    )
    expect(await rulesFor({ singleProxy: { scheme: 'socks5', host: '127.0.0.1', port: 1080 } })).to.equal(
      'socks5://127.0.0.1:1080',
    )
    expect(await rulesFor({ singleProxy: { host: '::1', port: 8080 } })).to.equal('http://[::1]:8080')
    expect(
      await rulesFor({
        proxyForHttp: { scheme: 'http', host: 'a.example', port: 80 },
        proxyForHttps: { scheme: 'https', host: 'b.example', port: 443 },
        fallbackProxy: { scheme: 'socks5', host: 'c.example', port: 1080 },
      }),
    ).to.equal('http=http://a.example:80;https=https://b.example:443;socks=socks5://c.example:1080')
    // A port that is not one is left out rather than passed on.
    expect(await rulesFor({ singleProxy: { scheme: 'http', host: 'a.example', port: 70000 } })).to.equal(
      'http://a.example',
    )
  })

  it('fixed_servers refuses rules it cannot pass on, as Chrome does', async () => {
    for (const rules of [
      {},
      { singleProxy: { scheme: 'http', host: 'a.example;direct://', port: 80 } },
      { singleProxy: { scheme: 'quic', host: 'a.example', port: 443 } },
      { singleProxy: { scheme: 'http', host: '' } },
    ] as chrome.proxy.ProxyRules[]) {
      const { handlers, setProxyCalls, onChangeCalls, evt } = createHarness()
      let error: Error | undefined
      try {
        await handlers.get('proxy.settings.set')!(evt('ext-1'), {
          value: { mode: 'fixed_servers', rules },
        })
      } catch (err) {
        error = err as Error
      }
      expect(error?.message, JSON.stringify(rules)).to.equal("Invalid 'rules' specified.")
      // Nothing went out directly, and the extension isn't told its proxy is on.
      expect(setProxyCalls).to.have.length(0)
      expect(onChangeCalls).to.have.length(0)
      const out = await handlers.get('proxy.settings.get')!(evt('ext-1'))
      expect(out.value).to.deep.equal({ mode: 'system' })
    }
  })
})

