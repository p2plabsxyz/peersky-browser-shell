import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { chromeTypeName } from './alarms'
import { getExtensionManifest } from './common'

const redirectDomain = 'chromiumapp.org'

/** Chromium resolves https://<id>.chromiumapp.org/ itself; Electron asks DNS and fails. */
const ERR_NAME_NOT_RESOLVED = -105
const ERR_ABORTED = -3

const WAF_SIGNATURE =
  'identity.launchWebAuthFlow(identity.WebAuthFlowDetails details, optional function callback)'

const INVALID_SCHEME = 'The auth url has an invalid scheme. Only http:// and https:// schemes are allowed.'
const PAGE_LOAD_FAILED = 'Authorization page could not be loaded.'
const USER_REJECTED = 'The user did not approve access.'
const INTERACTION_REQUIRED =
  'User interaction required. Try setting `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive` if multiple navigations are required, or if code is used for redirects in the authorization page after it\'s loaded.'

/** How long a flow without the person may run before it gives up. */
const NON_INTERACTIVE_LIMIT_MS = 60_000
/** Chrome's longest wait after the page loads, when the extension asks to wait. */
const MAX_WAIT_AFTER_LOAD_MS = 30_000

const invocationError = (signature: string, detail: string) =>
  new Error(`Error in invocation of ${signature}: ${detail}`)

export class IdentityAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()

    handle('identity.launchWebAuthFlow', this.launchWebAuthFlow)
    handle('identity.getAuthToken', this.getAuthToken)
    handle('identity.getProfileUserInfo', this.getProfileUserInfo)
    handle('identity.getAccounts', () => [])
    handle('identity.removeCachedAuthToken', this.removeCachedAuthToken)
    handle('identity.clearAllCachedAuthTokens', () => undefined)
  }

  /**
   * Loads the auth page in a window of the extension's session, follows its
   * redirects, and resolves with the https://<id>.chromiumapp.org/ URL it
   * reaches. The window shows only for an interactive flow, once the page has
   * loaded without redirecting.
   */
  private launchWebAuthFlow = async ({ extension }: ExtensionEvent, details: unknown): Promise<string> => {
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      throw invocationError(WAF_SIGNATURE, 'No matching signature.')
    }
    const options = details as Record<string, unknown>
    if (options.url === undefined) {
      throw invocationError(WAF_SIGNATURE, "Error at parameter 'details': Missing required property 'url'.")
    }
    if (typeof options.url !== 'string') {
      throw invocationError(
        WAF_SIGNATURE,
        `Error at parameter 'details': Error at property 'url': Invalid type: expected string, found ${chromeTypeName(options.url)}.`,
      )
    }
    for (const key of ['interactive', 'abortOnLoadForNonInteractive']) {
      if (options[key] !== undefined && typeof options[key] !== 'boolean') {
        throw invocationError(
          WAF_SIGNATURE,
          `Error at parameter 'details': Error at property '${key}': Invalid type: expected boolean, found ${chromeTypeName(options[key])}.`,
        )
      }
    }
    if (options.timeoutMsForNonInteractive !== undefined && !Number.isInteger(options.timeoutMsForNonInteractive)) {
      throw invocationError(
        WAF_SIGNATURE,
        `Error at parameter 'details': Error at property 'timeoutMsForNonInteractive': Invalid type: expected integer, found ${chromeTypeName(options.timeoutMsForNonInteractive)}.`,
      )
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(options.url)
    } catch {
      throw new Error(INVALID_SCHEME)
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error(INVALID_SCHEME)
    }

    const interactive = options.interactive === true
    const abortOnLoad = options.abortOnLoadForNonInteractive !== false
    const waitAfterLoad = Math.min(
      Math.max(typeof options.timeoutMsForNonInteractive === 'number' ? options.timeoutMsForNonInteractive : 1000, 0),
      MAX_WAIT_AFTER_LOAD_MS,
    )
    const callbackHost = `${extension.id}.${redirectDomain}`

    return new Promise<string>((resolve, reject) => {
      const win = new BrowserWindow({
        width: 500,
        height: 600,
        show: false,
        webPreferences: {
          session: this.ctx.session,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      const wc = win.webContents
      let done = false
      let waitTimer: NodeJS.Timeout | undefined
      const limitTimer = interactive
        ? undefined
        : setTimeout(() => finish(new Error(INTERACTION_REQUIRED)), NON_INTERACTIVE_LIMIT_MS)

      const finish = (result: string | Error) => {
        if (done) return
        done = true
        if (waitTimer) clearTimeout(waitTimer)
        if (limitTimer) clearTimeout(limitTimer)
        if (!win.isDestroyed()) win.destroy()
        if (typeof result === 'string') resolve(result)
        else reject(result)
      }

      const isCallback = (target: string) => {
        try {
          return new URL(target).hostname === callbackHost
        } catch {
          return false
        }
      }
      // The flow stays on the web: a page in it may not open the browser's
      // own pages, files or another extension's.
      const isWeb = (target: string) => /^https?:/i.test(target)

      const onNavigate = (event: Electron.Event, target: string) => {
        if (isCallback(target)) {
          event.preventDefault()
          finish(target)
        } else if (!isWeb(target)) {
          event.preventDefault()
        }
      }

      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.on('will-navigate', onNavigate)
      wc.on('will-redirect', onNavigate)
      wc.on('did-fail-load', (_event, errorCode, _description, validatedURL, isMainFrame) => {
        if (!isMainFrame || done) return
        // Another extension's chromiumapp.org name does not resolve, as in Chrome.
        if (errorCode === ERR_NAME_NOT_RESOLVED && isCallback(validatedURL)) return finish(validatedURL)
        if (errorCode === ERR_ABORTED) return
        finish(new Error(PAGE_LOAD_FAILED))
      })
      wc.on('did-navigate', (_event, url, httpResponseCode) => {
        if (isCallback(url)) return finish(url)
        if (httpResponseCode >= 400) finish(new Error(PAGE_LOAD_FAILED))
      })
      wc.on('did-finish-load', () => {
        if (done) return
        if (interactive) {
          if (!win.isDestroyed()) {
            win.show()
            win.focus()
          }
          return
        }
        // Without the person, a page that is still here once it loaded needs
        // them, unless the extension asked to wait for a script's redirect.
        if (abortOnLoad) return finish(new Error(INTERACTION_REQUIRED))
        if (waitTimer) clearTimeout(waitTimer)
        waitTimer = setTimeout(() => finish(new Error(INTERACTION_REQUIRED)), waitAfterLoad)
      })
      win.on('closed', () => finish(new Error(USER_REJECTED)))

      wc.loadURL(parsedUrl.toString()).catch(() => {
        // did-fail-load or a redirect already decided the outcome.
      })
    })
  }

  /** Tokens come from a Google account in Chrome, which PeerSky does not have. */
  private getAuthToken = async ({ extension }: ExtensionEvent, details?: unknown) => {
    if (details !== undefined && details !== null && (typeof details !== 'object' || Array.isArray(details))) {
      throw invocationError(
        'identity.getAuthToken(optional identity.TokenDetails details, optional function callback)',
        'No matching signature.',
      )
    }
    const oauth2 = (getExtensionManifest(extension) as any).oauth2
    if (!oauth2 || typeof oauth2.client_id !== 'string' || !oauth2.client_id) {
      throw new Error('Invalid OAuth2 Client ID.')
    }
    throw new Error('The user is not signed in.')
  }

  /** No account is signed in to the browser, so Chrome's answer is empty. */
  private getProfileUserInfo = (_event: ExtensionEvent, details?: unknown) => {
    if (details !== undefined && details !== null) {
      if (typeof details !== 'object' || Array.isArray(details)) {
        throw invocationError(
          'identity.getProfileUserInfo(optional identity.ProfileDetails details, optional function callback)',
          'No matching signature.',
        )
      }
      const status = (details as { accountStatus?: unknown }).accountStatus
      if (status !== undefined && status !== 'ANY' && status !== 'SYNC') {
        throw invocationError(
          'identity.getProfileUserInfo(optional identity.ProfileDetails details, optional function callback)',
          "Error at parameter 'details': Error at property 'accountStatus': Value must be one of ANY, SYNC.",
        )
      }
    }
    return { email: '', id: '' }
  }

  private removeCachedAuthToken = (_event: ExtensionEvent, details?: unknown) => {
    const signature =
      'identity.removeCachedAuthToken(identity.InvalidTokenDetails details, optional function callback)'
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      throw invocationError(signature, 'No matching signature.')
    }
    if (typeof (details as { token?: unknown }).token !== 'string') {
      throw invocationError(signature, "Error at parameter 'details': Missing required property 'token'.")
    }
  }
}
