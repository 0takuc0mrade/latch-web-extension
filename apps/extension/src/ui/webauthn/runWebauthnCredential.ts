import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

import type { Surface } from '../routing/routes'
import {
  formatWebauthnBrowserError,
  prepareAuthenticationOptionsForGet,
  prepareRegistrationOptionsForCreate,
} from './passkey'
import { openPasskeyBridgeAndWait } from './passkeyBridge'

/**
 * Chrome does not reliably run WebAuthn inside the extension side panel (hangs with no UI).
 * Side panel opens the shared `tabs/passkey-bridge` window.
 * Durable popup surfaces use in-page credentials (Touch ID / Windows Hello / hybrid QR).
 * Ephemeral action popups must call `ensureDurableWalletUi` before this helper.
 */
export async function runWebauthnCredential(
  surface: Surface,
  mode: 'registration' | 'authentication',
  optionsJSON: unknown
): Promise<unknown> {
  try {
    if (surface === 'sidepanel') {
      return await openPasskeyBridgeAndWait({ mode, optionsJSON })
    }
    if (mode === 'registration') {
      return await startRegistration({
        optionsJSON: prepareRegistrationOptionsForCreate(optionsJSON),
      } as unknown as Parameters<typeof startRegistration>[0])
    }
    return await startAuthentication({
      optionsJSON: prepareAuthenticationOptionsForGet(optionsJSON),
    } as unknown as Parameters<typeof startAuthentication>[0])
  } catch (e) {
    throw new Error(formatWebauthnBrowserError(e))
  }
}
