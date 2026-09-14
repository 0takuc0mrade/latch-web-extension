import { formatWebauthnBrowserError } from './passkey'
import { openPasskeyBridgeAndWait } from './passkeyBridge'
import type { Surface } from '../routing/routes'

/**
 * Always run WebAuthn in `tabs/passkey-bridge` for popup and side panel.
 * Background owns the bridge waiter so action-popup destruction cannot drop the ceremony.
 * Onboarding full-tab flows that call @simplewebauthn/browser directly are unchanged.
 */
export async function runWebauthnCredential(
  _surface: Surface,
  mode: 'registration' | 'authentication',
  optionsJSON: unknown
): Promise<unknown> {
  try {
    return await openPasskeyBridgeAndWait({ mode, optionsJSON })
  } catch (e) {
    throw new Error(formatWebauthnBrowserError(e))
  }
}
