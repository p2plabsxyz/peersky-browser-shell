import { expect } from 'chai'
import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.storage.sync', () => {
  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-storage-sync',
  })

  beforeEach(async () => {
    // Clear storage before each test
    await browser.crx.exec('storage.sync.clear')
  })

  describe('set() and get()', () => {
    it('stores and retrieves string values', async () => {
      await browser.crx.exec('storage.sync.set', { testKey: 'testValue' })
      const data = await browser.crx.exec('storage.sync.get', 'testKey')
      expect(data).to.deep.equal({ testKey: 'testValue' })
    })

    it('stores and retrieves complex objects', async () => {
      const complexData = { a: 1, b: [2, 3], c: { d: false } }
      await browser.crx.exec('storage.sync.set', { complexObj: complexData })
      const data = await browser.crx.exec('storage.sync.get', ['complexObj'])
      expect(data).to.deep.equal({ complexObj: complexData })
    })

    it('returns empty object for unknown keys', async () => {
      const data = await browser.crx.exec('storage.sync.get', 'missing')
      expect(data).to.deep.equal({})
    })

    it('returns default values if set', async () => {
      const data = await browser.crx.exec('storage.sync.get', { missing: 'default fallback' })
      expect(data).to.deep.equal({ missing: 'default fallback' })
    })

    it('merges values and preserves unrelated keys', async () => {
      await browser.crx.exec('storage.sync.set', { first: 1 })
      await browser.crx.exec('storage.sync.set', { second: 2 })
      const data = await browser.crx.exec('storage.sync.get', null)
      expect(data).to.deep.equal({ first: 1, second: 2 })
    })
  })

  describe('remove()', () => {
    it('removes specific keys', async () => {
      await browser.crx.exec('storage.sync.set', { first: 1, second: 2 })
      await browser.crx.exec('storage.sync.remove', 'first')
      const data = await browser.crx.exec('storage.sync.get', null)
      expect(data).to.deep.equal({ second: 2 })
    })

    it('ignores removing non-existent keys', async () => {
      await browser.crx.exec('storage.sync.set', { active: true })
      await browser.crx.exec('storage.sync.remove', 'missing')
      const data = await browser.crx.exec('storage.sync.get', null)
      expect(data).to.deep.equal({ active: true })
    })
  })

  describe('clear()', () => {
    it('clears all data', async () => {
      await browser.crx.exec('storage.sync.set', { first: 1, second: 2 })
      await browser.crx.exec('storage.sync.clear')
      const data = await browser.crx.exec('storage.sync.get', null)
      expect(data).to.deep.equal({})
    })
  })

  describe('getBytesInUse()', () => {
    it('returns approximate byte size of stored data', async () => {
      const initialBytes = await browser.crx.exec('storage.sync.getBytesInUse', null)
      
      await browser.crx.exec('storage.sync.set', { someKey: 'someValue123' })
      const newBytes = await browser.crx.exec('storage.sync.getBytesInUse', null)
      
      expect(newBytes).to.be.greaterThan(initialBytes as number)
      
      const specificBytes = await browser.crx.exec('storage.sync.getBytesInUse', 'someKey')
      expect(specificBytes).to.equal(newBytes)
    })
  })

  describe('onChanged event', () => {
    it('fires when storage is updated', async () => {
      // Create a promise that waits for the onChanged event
      const eventPromise = browser.crx.eventOnce('storage.onChanged')
      
      await browser.crx.exec('storage.sync.set', { newVal: 'test' })
      
      const [changes, areaName] = await eventPromise
      expect(areaName).to.equal('sync')
      expect(changes).to.have.property('newVal')
      expect(changes.newVal).to.deep.equal({ newValue: 'test' })
    })

    it('fires when storage is removed', async () => {
      await browser.crx.exec('storage.sync.set', { toBeRemoved: 123 })
      
      const eventPromise = browser.crx.eventOnce('storage.onChanged')
      await browser.crx.exec('storage.sync.remove', 'toBeRemoved')
      
      const [changes, areaName] = await eventPromise
      expect(areaName).to.equal('sync')
      expect(changes).to.have.property('toBeRemoved')
      expect(changes.toBeRemoved).to.deep.equal({ oldValue: 123 })
    })
  })
})
