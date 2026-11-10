import { expect } from 'chai'
import { noteInvocation } from '../src/browser/invocation'
import { ExtensionPermissions } from '../src/browser/permissions'

// A toolbar click, a context menu item, a shortcut or the omnibox gives the
// extension activeTab on that tab, as in Chrome: its page only, until it
// leaves for another origin.
describe('invoking an extension on a tab', () => {
  const setup = (permissions: string[]) => {
    const extension: any = { id: 'ext', name: 'Ext', manifest: { manifest_version: 3, permissions } }
    const perms = new ExtensionPermissions({
      stateStore: { whenHydrated: async () => {}, getNamespace: (_n: string, f: any) => f, setNamespace() {} },
      sendEvent() {},
      prompt: async () => false,
    })
    let url = 'https://a.example/page'
    const tab: any = { id: 7, isDestroyed: () => false, getURL: () => url }
    const gestures: string[] = []
    const ctx: any = {
      session: { extensions: { getExtension: (id: string) => (id === 'ext' ? extension : undefined) } },
      store: {
        tabs: new Set([tab]),
        noteUserGesture: (id: string) => gestures.push(id),
        getTabIdForWebContentsId: (id: number) => id,
      },
      permissions: perms,
    }
    return { ctx, extension, perms, tab, gestures, navigate: (next: string) => (url = next) }
  }

  it('grants activeTab for the page of that tab only', () => {
    const { ctx, extension, perms, tab, gestures } = setup(['activeTab'])
    expect(perms.hasHostAccess(extension, 'https://a.example/x', { tabId: 7 })).to.equal(false)
    noteInvocation(ctx, 'ext', tab)
    expect(gestures).to.deep.equal(['ext'])
    expect(perms.hasHostAccess(extension, 'https://a.example/x', { tabId: 7 })).to.equal(true)
    expect(perms.hasHostAccess(extension, 'https://a.example/x', { tabId: 8 })).to.equal(false)
    expect(perms.hasHostAccess(extension, 'https://b.example/', { tabId: 7 })).to.equal(false)
    perms.revokeActiveTab(7, 'https://b.example/')
    expect(perms.hasHostAccess(extension, 'https://a.example/x', { tabId: 7 })).to.equal(false)
  })

  it('grants nothing without activeTab', () => {
    const { ctx, extension, perms, tab } = setup([])
    noteInvocation(ctx, 'ext', tab)
    expect(perms.hasHostAccess(extension, 'https://a.example/x', { tabId: 7 })).to.equal(false)
  })

  it('grants nothing on a page with an opaque origin', () => {
    const { ctx, extension, perms, tab, navigate } = setup(['activeTab'])
    navigate('about:blank')
    noteInvocation(ctx, 'ext', tab)
    expect(perms.hasHostAccess(extension, 'about:blank', { tabId: 7 })).to.equal(false)
    expect(perms.hasHostAccess(extension, 'data:text/html,hi', { tabId: 7 })).to.equal(false)
  })
})
