import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const redirectDomain = 'chromiumapp.org'

/** Chrome extension OAuth redirect URL prefix: https://<extensionId>.chromiumapp.org/ */
function getRedirectUrlPrefix(extensionId: string): string {
  return `https://${extensionId}.${redirectDomain}/`
}

export class IdentityAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()

    handle('identity.launchWebAuthFlow', this.launchWebAuthFlow, {
      extensionContext: true,
      permission: 'identity',
    })
    handle('identity.getAuthToken', this.getAuthToken, {
      extensionContext: true,
      permission: 'identity',
    })
  }

  private launchWebAuthFlow = async (
    { extension }: ExtensionEvent,
    options: { url: string; interactive?: boolean },
  ): Promise<string> => {
    const { url } = options ?? {}
    if (!url || typeof url !== 'string') {
      throw new Error('chrome.identity.launchWebAuthFlow: options.url is required')
    }

    const extensionId = extension.id
    const redirectPrefix = getRedirectUrlPrefix(extensionId)

    return new Promise<string>((resolve, reject) => {
      const shouldShow = options?.interactive !== false
      const win = new BrowserWindow({
        width: 500,
        height: 600,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          session: this.ctx.session,
        },
      })

      const cleanup = () => {
        if (win && !win.isDestroyed()) {
          win.removeListener('closed', onClosed)
          const wc = win.webContents
          if (wc && !wc.isDestroyed()) {
            wc.removeListener('will-redirect', onRedirect)
            wc.removeListener('will-navigate', onWillNavigate)
            wc.removeListener('did-navigate', onNavigate)
          }
          win.destroy()
        }
      }

      const checkRedirect = (targetUrl: string): boolean => {
        if (!targetUrl || typeof targetUrl !== 'string') return false
        return targetUrl.startsWith(redirectPrefix)
      }

      const captureAndResolve = (callbackUrl: string) => {
        cleanup()
        resolve(callbackUrl)
      }

      const onRedirect = (
        _event: Electron.Event,
        urlRedirect: string,
        _isInPlace: boolean,
        _isMainFrame: boolean,
      ) => {
        if (checkRedirect(urlRedirect)) captureAndResolve(urlRedirect)
      }

      /** Intercept client-side redirects before loading the chromiumapp.org URL. */
      const onWillNavigate = (event: Electron.Event, navUrl: string) => {
        if (checkRedirect(navUrl)) {
          event.preventDefault()
          captureAndResolve(navUrl)
        }
      }

      const onNavigate = (_event: Electron.Event, navUrl: string) => {
        if (checkRedirect(navUrl)) captureAndResolve(navUrl)
      }

      const onClosed = () => {
        cleanup()
        reject(new Error('User closed the OAuth window'))
      }

      win.webContents.on('will-redirect', onRedirect)
      win.webContents.on('will-navigate', onWillNavigate)
      win.webContents.on('did-navigate', onNavigate)
      win.on('closed', onClosed)

      if (shouldShow) {
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) {
            win.show()
            win.focus()
          }
        })
      }

      win.loadURL(url).catch((err) => {
        cleanup()
        reject(new Error(`Failed to load OAuth URL: ${err.message}`))
      })
    })
  }

  private getAuthToken = async (
    _event: ExtensionEvent,
    _options?: { interactive?: boolean },
  ): Promise<never> => {
    throw new Error(
      'chrome.identity.getAuthToken is not supported in Peersky. Use chrome.identity.launchWebAuthFlow for OAuth flows.',
    )
  }
}
