import { expect } from 'chai'

import { ProxyAPI } from '../src/browser/api/proxy'
import { last, settingsHarness, tick } from './settings-harness'

describe('chrome.proxy', () => {
  const setup = (state: Record<string, unknown> = {}) => {
    const h = settingsHarness(state)
    const proxy = new ProxyAPI(h.ctx)
    const ext1 = h.extension('ext-1', ['proxy'])
    const ext2 = h.extension('ext-2', ['proxy'])
    return { ...h, proxy, ext1, ext2 }
  }
  const proxyChanges = (h: ReturnType<typeof setup>) =>
    h.emitted.filter((e) => e.name === 'proxy-changed').map((e) => e.payload)
  const onChanges = (h: ReturnType<typeof setup>, extensionId: string) =>
    h.events.filter((e) => e.name === 'proxy.settings.onChange' && e.extensionId === extensionId).map((e) => e.args[0])

  it('settings.get returns the system config, controllable, as Chrome does', async () => {
    const h = setup()
    await h.load(h.ext1)
    const out = await h.call('proxy.settings.get', h.ext1, {})
    expect(out).to.deep.equal({ levelOfControl: 'controllable_by_this_extension', value: { mode: 'system' } })
  })

  it('settings.set applies the config and tells every extension its own level of control', async () => {
    const h = setup()
    await h.load(h.ext1)
    await h.load(h.ext2)
    await h.call('proxy.settings.set', h.ext2, { value: { mode: 'direct' } })

    expect(h.proxyCalls).to.deep.equal([{ mode: 'direct' }])
    expect(onChanges(h, 'ext-2')).to.deep.equal([{ levelOfControl: 'controlled_by_this_extension', value: { mode: 'direct' } }])
    // ext-1 was installed first, so ext-2 wins over it.
    expect(onChanges(h, 'ext-1')).to.deep.equal([{ levelOfControl: 'controlled_by_other_extensions', value: { mode: 'direct' } }])
    expect((await h.call('proxy.settings.get', h.ext1, {})).levelOfControl).to.equal('controlled_by_other_extensions')
  })

  it('an extension installed later may take over, and its clear gives control back', async () => {
    const h = setup()
    await h.load(h.ext1)
    await h.load(h.ext2)
    await h.call('proxy.settings.set', h.ext1, { value: { mode: 'direct' } })
    // ext-2 is newer: it can take over.
    expect((await h.call('proxy.settings.get', h.ext2, {})).levelOfControl).to.equal('controllable_by_this_extension')
    await h.call('proxy.settings.set', h.ext2, { value: { mode: 'auto_detect' } })
    expect(last(h.proxyCalls)).to.deep.equal({ mode: 'auto_detect' })
    // A clear from the extension not in control changes nothing that counts.
    await h.call('proxy.settings.clear', h.ext1, {})
    expect(h.proxyCalls).to.have.length(2)
    await h.call('proxy.settings.clear', h.ext2, {})
    expect(last(h.proxyCalls)).to.deep.equal({ mode: 'system' })
    expect(await h.call('proxy.settings.get', h.ext1, {})).to.deep.equal({
      levelOfControl: 'controllable_by_this_extension',
      value: { mode: 'system' },
    })
  })

  it('stops applying an extension proxy while it is unloaded, and brings it back after a restart', async () => {
    const state = {}
    const h = setup(state)
    await h.load(h.ext1)
    await h.call('proxy.settings.set', h.ext1, { value: { mode: 'fixed_servers', rules: { singleProxy: { host: '127.0.0.1', port: 9 } } } })
    await h.unload(h.ext1)
    expect(last(h.proxyCalls)).to.deep.equal({ mode: 'system' })

    const after = setup(state)
    await after.load(after.ext1)
    expect(after.proxyCalls).to.deep.equal([{ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' }])
    expect((await after.call('proxy.settings.get', after.ext1, {})).value).to.deep.equal({
      mode: 'fixed_servers',
      rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 9 } },
    })
  })

  it('tells the host which proxy counts and which extension set it, once the session uses it', async () => {
    const h = setup()
    await h.load(h.ext1)
    expect(h.proxy.getSettings()).to.equal(null)

    const vpn = { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'https', host: 'vpn.example', port: 443 } } }
    await h.call('proxy.settings.set', h.ext1, { value: vpn })
    expect(h.proxy.getSettings()).to.deep.equal({ value: vpn, extensionId: 'ext-1' })
    expect(proxyChanges(h)).to.deep.equal([{ value: vpn, extensionId: 'ext-1' }])
    expect(h.proxyCalls).to.deep.equal([{ mode: 'fixed_servers', proxyRules: 'https://vpn.example:443' }])

    // Turned off, its proxy stops counting, and the host hears there is none.
    await h.unload(h.ext1)
    expect(h.proxy.getSettings()).to.equal(null)
    expect(proxyChanges(h)).to.deep.equal([{ value: vpn, extensionId: 'ext-1' }, null])

    // What the host is handed is a copy.
    await h.load(h.ext1)
    h.proxy.getSettings()!.value.mode = 'direct'
    expect(h.proxy.getSettings()!.value).to.deep.equal(vpn)
  })

  it('puts back a proxy the host kept, counting it once its extension loads, as if the extension had set it', async () => {
    const state = {}
    const h = setup(state)
    const pac = 'function FindProxyForURL() { return "HTTPS vpn.example:443" }'
    // Kept as Chrome keeps what an extension sets.
    const vpn = { mode: 'pac_script', pacScript: { data: pac, mandatory: false } }

    expect(await h.proxy.restore('ext-1', { mode: 'pac_script', pacScript: { data: pac } } as chrome.proxy.ProxyConfig)).to.equal(true)
    // Not loaded yet: nothing counts, and the session is left alone.
    expect(h.proxy.getSettings()).to.equal(null)
    expect(h.proxyCalls).to.deep.equal([])

    await h.load(h.ext1)
    expect(h.proxy.getSettings()).to.deep.equal({ value: vpn, extensionId: 'ext-1' })
    expect(h.proxyCalls).to.have.length(1)
    expect(h.proxyCalls[0].mode).to.equal('pac_script')
    expect(await h.call('proxy.settings.get', h.ext1, {})).to.deep.equal({
      levelOfControl: 'controlled_by_this_extension',
      value: vpn,
    })

    // It is the extension's own setting from then on: kept across a restart,
    // where the host handing back what it kept changes nothing, and gone with
    // the extension's clear.
    const after = setup(state)
    expect(await after.proxy.restore('ext-1', { mode: 'direct' })).to.equal(false)
    await after.load(after.ext1)
    expect(after.proxy.getSettings()).to.deep.equal({ value: vpn, extensionId: 'ext-1' })
    await after.call('proxy.settings.clear', after.ext1, {})
    expect(after.proxy.getSettings()).to.equal(null)
    expect(last(after.proxyCalls)).to.deep.equal({ mode: 'system' })
  })

  it('refuses to put back a proxy Chrome would refuse', async () => {
    const h = setup()
    const refusal = async (id: any, value: any) => {
      try {
        await h.proxy.restore(id, value)
      } catch (error) {
        return (error as Error).message
      }
      return null
    }
    expect(await refusal('ext-1', { mode: 'fixed_servers' })).to.equal("Proxy mode 'fixed_servers' requires a 'rules' field.")
    expect(await refusal('', { mode: 'direct' })).to.equal('An extension id is required.')
    expect(h.proxy.getSettings()).to.equal(null)
  })

  it('fixed_servers maps to Electron proxyRules and bypass list', async () => {
    const h = setup()
    await h.call('proxy.settings.set', h.ext1, {
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port: 8888 },
          bypassList: ['localhost', '127.0.0.1'],
        },
      },
    })
    expect(h.proxyCalls[0]).to.deep.equal({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:8888',
      proxyBypassRules: 'localhost,127.0.0.1',
    })
  })

  // Without a scheme on each server, Chromium took an HTTPS proxy for a plain
  // HTTP one and SOCKS5 for SOCKS4.
  it('fixed_servers keeps each proxy server its own scheme and fills in the port', async () => {
    const rulesFor = async (rules: chrome.proxy.ProxyRules) => {
      const h = setup()
      await h.call('proxy.settings.set', h.ext1, { value: { mode: 'fixed_servers', rules } })
      return h.proxyCalls[0].proxyRules
    }

    expect(await rulesFor({ singleProxy: { scheme: 'https', host: 'vpn.example', port: 443 } })).to.equal(
      'https://vpn.example:443',
    )
    expect(await rulesFor({ singleProxy: { scheme: 'socks5', host: '127.0.0.1' } })).to.equal('socks5://127.0.0.1:1080')
    expect(await rulesFor({ singleProxy: { host: '::1', port: 8080 } })).to.equal('http://[::1]:8080')
    expect(
      await rulesFor({
        proxyForHttp: { scheme: 'http', host: 'a.example', port: 80 },
        proxyForHttps: { scheme: 'https', host: 'b.example', port: 443 },
        fallbackProxy: { scheme: 'socks5', host: 'c.example', port: 1080 },
      }),
    ).to.equal('http=http://a.example:80;https=https://b.example:443;socks=socks5://c.example:1080')
    // A port that is not one gets the scheme's own.
    expect(await rulesFor({ singleProxy: { scheme: 'http', host: 'a.example', port: 70000 } })).to.equal(
      'http://a.example:80',
    )
    // Chrome keeps a QUIC proxy as an HTTP one.
    expect(await rulesFor({ singleProxy: { scheme: 'quic', host: 'a.example', port: 443 } })).to.equal(
      'http://a.example:443',
    )
  })

  it('refuses configs Chrome refuses, and hosts it cannot pass on, without going direct', async () => {
    const cases: Array<[any, string]> = [
      [{ mode: 'fixed_servers', rules: {} }, "Proxy mode 'fixed_servers' requires a 'rules' field."],
      [{ mode: 'fixed_servers' }, "Proxy mode 'fixed_servers' requires a 'rules' field."],
      [{ mode: 'fixed_servers', rules: { singleProxy: { host: '' } } }, "Invalid 'rules.???.host' entry. Hostname cannot be empty."],
      [{ mode: 'fixed_servers', rules: { singleProxy: { host: 'a.example;direct://' } } }, "Invalid 'rules' specified."],
      [{ mode: 'fixed_servers', rules: { singleProxy: { host: 'a b' } } }, "Invalid 'rules' specified."],
      [
        { mode: 'fixed_servers', rules: { singleProxy: { host: 'a.example' }, fallbackProxy: { host: 'b.example' } } },
        'Proxy rule for singleProxy and fallbackProxy cannot be set at the same time.',
      ],
      [{ mode: 'pac_script', pacScript: {} }, "Proxy mode 'pac_script' requires a 'pacScript' field with either a 'url' field or a 'data' field."],
      [{ mode: 'sideways' }, 'Invalid invocation'],
      [{ mode: 'direct', extra: true }, 'Invalid invocation'],
      [{ mode: 'fixed_servers', rules: { singleProxy: { host: 'a.example', port: '80' } } }, 'Invalid invocation'],
    ]
    for (const [value, message] of cases) {
      const h = setup()
      expect(await h.errorOf(h.call('proxy.settings.set', h.ext1, { value })), JSON.stringify(value)).to.equal(message)
      expect(h.proxyCalls).to.have.length(0)
      expect(h.events).to.have.length(0)
      expect((await h.call('proxy.settings.get', h.ext1, {})).value).to.deep.equal({ mode: 'system' })
    }
  })

  it('refuses incognito scopes and malformed details with Chrome errors', async () => {
    const h = setup()
    expect(await h.errorOf(h.call('proxy.settings.set', h.ext1, { value: { mode: 'direct' }, scope: 'incognito_persistent' }))).to.equal(
      'You do not have permission to access incognito preferences.',
    )
    expect(await h.errorOf(h.call('proxy.settings.get', h.ext1, { incognito: true }))).to.equal(
      'You do not have permission to access incognito preferences.',
    )
    expect(await h.errorOf(h.call('proxy.settings.set', h.ext1))).to.equal(
      'Error in invocation of types.ChromeSetting.set(object details, optional function callback): No matching signature.',
    )
    expect(await h.errorOf(h.call('proxy.settings.get', h.ext1, { foo: 1 }))).to.equal(
      "Error in invocation of types.ChromeSetting.get(object details, optional function callback): Error at parameter 'details': Unexpected property: 'foo'.",
    )
    await tick()
  })

  it('reports PAC scripts as Chrome keeps them and sends data as a data URL', async () => {
    const h = setup()
    await h.call('proxy.settings.set', h.ext1, { value: { mode: 'pac_script', pacScript: { data: 'function FindProxyForURL(){return "DIRECT"}' } } })
    expect((await h.call('proxy.settings.get', h.ext1, {})).value).to.deep.equal({
      mode: 'pac_script',
      pacScript: { data: 'function FindProxyForURL(){return "DIRECT"}', mandatory: false },
    })
    expect(h.proxyCalls[0].mode).to.equal('pac_script')
    expect(h.proxyCalls[0].pacScript).to.match(/^data:application\/x-ns-proxy-autoconfig;base64,/)
  })
})
