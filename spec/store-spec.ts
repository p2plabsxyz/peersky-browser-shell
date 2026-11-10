import { expect } from 'chai'
import { ExtensionStore } from '../src/browser/store'

describe('ExtensionStore', () => {
  const fakeWindow = (id: number): any => ({
    id,
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    on() {},
    once() {},
  })
  const fakeContents = (id: number): any => ({
    id,
    isDestroyed: () => false,
    executeJavaScript: async () => undefined,
  })

  it('takes the window from a host that answers createWindow with [webContents, window]', async () => {
    // PeerSky answers as its createTab does; the array once went into the
    // window list and broke windows.* for every extension.
    const win = fakeWindow(7)
    const store = new ExtensionStore({ createWindow: async () => [fakeContents(3), win] as any })
    expect(await store.createWindow({} as any, {})).to.equal(win)
    expect([...store.windows]).to.deep.equal([win])
  })

  it('refuses an answer with no window in it', async () => {
    const store = new ExtensionStore({ createWindow: async () => [fakeContents(3)] as any })
    await expect(store.createWindow({} as any, {})).to.be.rejectedWith('createWindow must return a BrowserWindow or BaseWindow')
    expect(store.windows.size).to.equal(0)
  })
})
