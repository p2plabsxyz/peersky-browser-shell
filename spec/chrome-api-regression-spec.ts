import { expect } from 'chai'
import { EventEmitter } from 'node:events'

import { CommandsAPI } from '../src/browser/api/commands'
import { CookiesAPI } from '../src/browser/api/cookies'
import { PermissionsAPI } from '../src/browser/api/permissions'
import { ExtensionPermissions } from '../src/browser/permissions'

const createRouterHarness = () => {
  const handlers = new Map<string, Function>()
  const events: Array<{ extensionId: string; name: string; payload: any }> = []
  return {
    handlers,
    events,
    router: {
      apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
      setPermissionResolver: () => null,
      sendEvent: (extensionId: string, name: string, payload: any) =>
        events.push({ extensionId, name, payload }),
      sendEventForEachListener: () => null,
      broadcastEvent: () => null,
    },
  }
}

describe('untested API behavior regressions', () => {
  describe('PermissionsAPI', () => {
    const extension: any = {
      id: 'ext-1',
      name: 'Ext',
      manifest: {
        manifest_version: 3,
        permissions: ['tabs', 'storage'],
        optional_permissions: ['bookmarks'],
        host_permissions: ['https://a.example/*'],
        optional_host_permissions: ['https://b.example/*'],
      },
    }
    const setup = (answer = true) => {
      const harness = createRouterHarness()
      const state: Record<string, unknown> = {}
      const permissions = new ExtensionPermissions({
        stateStore: {
          whenHydrated: async () => {},
          getNamespace: (name: string, fallback: any) => (state[name] as any) ?? fallback,
          setNamespace: (name: string, value: unknown) => {
            state[name] = value
          },
        },
        sendEvent: (extensionId: string, name: string, payload: any) =>
          harness.events.push({ extensionId, name, payload }),
        prompt: async () => answer,
      })
      const ctx: any = {
        router: harness.router,
        session: { extensions: new EventEmitter() },
        store: { hasUserGesture: () => false },
        permissions,
      }
      new PermissionsAPI(ctx)
      return { harness, permissions, state }
    }

    it('refuses to remove a required permission, as Chrome does', async () => {
      const { harness } = setup()
      expect(() => harness.handlers.get('permissions.remove')!({ extension }, { permissions: ['storage'] })).to.throw(
        'You cannot remove required permissions.',
      )
    })

    it('grants an optional permission only during a user gesture, and keeps it', async () => {
      const { harness, state } = setup()
      const request = harness.handlers.get('permissions.request')!
      await expect(request({ extension, gesture: false }, { permissions: ['bookmarks'] })).to.be.rejectedWith(
        'This function must be called during a user gesture',
      )
      expect(await request({ extension, gesture: true }, { permissions: ['bookmarks'] })).to.equal(true)
      expect(harness.events.find((e) => e.name === 'permissions.onAdded')?.payload).to.deep.equal({
        permissions: ['bookmarks'],
        origins: [],
      })
      expect(state.permissions).to.deep.equal({ 'ext-1': { apis: ['bookmarks'], origins: [] } })
    })

    it('grants nothing when the person says no', async () => {
      const { harness } = setup(false)
      const request = harness.handlers.get('permissions.request')!
      expect(await request({ extension, gesture: true }, { origins: ['https://b.example/*'] })).to.equal(false)
      expect(await harness.handlers.get('permissions.contains')!({ extension }, { origins: ['https://b.example/*'] })).to.equal(false)
    })

    it('refuses a permission the manifest does not offer', async () => {
      const { harness } = setup()
      const request = harness.handlers.get('permissions.request')!
      await expect(request({ extension, gesture: true }, { permissions: ['history'] })).to.be.rejectedWith(
        'Only permissions specified in the manifest may be requested.',
      )
    })

    it('removes a granted optional permission and emits onRemoved', async () => {
      const { harness } = setup()
      await harness.handlers.get('permissions.request')!({ extension, gesture: true }, { permissions: ['bookmarks'] })
      expect(harness.handlers.get('permissions.remove')!({ extension }, { permissions: ['bookmarks'] })).to.equal(true)
      expect(harness.handlers.get('permissions.getAll')!({ extension }).permissions).to.deep.equal(['tabs', 'storage'])
      expect(harness.events.find((e) => e.name === 'permissions.onRemoved')?.payload).to.deep.equal({
        permissions: ['bookmarks'],
        origins: [],
      })
    })
  })

  describe('CookiesAPI', () => {
    it('returns the longest-path cookie when multiple cookies match', async () => {
      const harness = createRouterHarness()
      const cookies = {
        addListener: () => null,
        get: async () => [
          { name: 'sid', path: '/', domain: 'example.com', creation: 5 },
          { name: 'sid', path: '/app/deep', domain: 'example.com', creation: 9 },
        ],
        set: async () => null,
        remove: async () => null,
      }
      const ctx: any = {
        router: harness.router,
        session: { cookies },
        store: { tabs: new Set() },
        permissions: { has: () => true, hasHostAccess: () => true },
      }
      new CookiesAPI(ctx)

      const result = await harness.handlers
        .get('cookies.get')!({}, { url: 'https://example.com/app/deep', name: 'sid' })

      expect(result).to.be.an('object')
      expect(result.path).to.equal('/app/deep')
    })
  })

  describe('CommandsAPI', () => {
    it('reads existing extension commands and exposes default shortcuts', async () => {
      const harness = createRouterHarness()
      const sessionExtensions = new EventEmitter() as any
      sessionExtensions.getAllExtensions = () => [
        {
          id: 'ext-cmd',
          manifest: {
            commands: {
              toggle: {
                description: 'Toggle action',
                suggested_key: { default: 'Ctrl+Shift+Y' },
              },
            },
          },
        },
      ]
      const ctx: any = {
        router: harness.router,
        session: { extensions: sessionExtensions },
      }
      new CommandsAPI(ctx)

      const commands = await harness.handlers.get('commands.getAll')!({
        extension: { id: 'ext-cmd' },
      })
      // Chrome shows a shortcut in the platform's own form.
      expect(commands).to.deep.equal([
        {
          name: 'toggle',
          description: 'Toggle action',
          shortcut: process.platform === 'darwin' ? '⇧⌘Y' : 'Ctrl+Shift+Y',
        },
      ])
    })
  })
})
