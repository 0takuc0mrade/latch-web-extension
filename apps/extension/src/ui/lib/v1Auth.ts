import type { startAuthentication } from '@simplewebauthn/browser'

import { formatFundError } from '../fund/fundErrors'
import { friendlyError, sendToBackground } from './backgroundClient'
import {
  assertPasskeyAssertionMatchesV1Challenge,
  passkeyAuthenticationOptionsForV1Challenge,
  prepareAuthenticationOptionsForGet,
} from '../webauthn/passkey'
import { runWebauthnCredential } from '../webauthn/runWebauthnCredential'

async function tryEnsureV1Auth(linkedAccountId: string): Promise<boolean> {
  const res = await sendToBackground<{ linkedAccountId: string }, { ok: true }>({
    type: 'COSIGN_ENSURE_V1_AUTH',
    payload: { linkedAccountId },
  })
  // Require data — a bare `{ ok: true }` is the legacy default handler for unknown messages.
  return Boolean(res.ok && res.data)
}

async function signInWithPasskey(args: {
  linkedAccountId: string
  credentialId: string
  surface: 'popup' | 'sidepanel'
}) {
  const challengeRes = await sendToBackground<
    { linkedAccountId: string },
    { wallet: string; nonce: string; keyType: string; network?: string }
  >({
    type: 'COSIGN_V1_AUTH_CHALLENGE',
    payload: { linkedAccountId: args.linkedAccountId },
  })
  if (!challengeRes.ok || !challengeRes.data) {
    throw new Error(formatFundError(challengeRes.error) || friendlyError(challengeRes.error))
  }
  const { wallet, nonce, keyType } = challengeRes.data

  // Build get() options locally from the V1 nonce — do not use /api/webauthn/authentication/begin.
  const prepared = prepareAuthenticationOptionsForGet(
    passkeyAuthenticationOptionsForV1Challenge({
      credentialId: args.credentialId,
      challengeBase64Url: nonce,
    })
  )

  const assertion = (await runWebauthnCredential(
    args.surface,
    'authentication',
    prepared
  )) as Awaited<ReturnType<typeof startAuthentication>>

  assertPasskeyAssertionMatchesV1Challenge(assertion, nonce)

  const signInRes = await sendToBackground<
    {
      linkedAccountId: string
      wallet: string
      keyType: string
      nonce: string
      response: unknown
    },
    { ok: true }
  >({
    type: 'COSIGN_V1_AUTH_SIGN_IN',
    payload: {
      linkedAccountId: args.linkedAccountId,
      wallet,
      keyType,
      nonce,
      response: assertion,
    },
  })
  if (!signInRes.ok) {
    throw new Error(formatFundError(signInRes.error, { wallet }))
  }
}

/** Ensure a Bearer JWT is available for `/v1/*` calls (deposit-intent, cosign, etc.). */
export async function ensureV1Auth(args: {
  linkedAccountId: string
  passkeyCredentialId?: string
  surface: 'popup' | 'sidepanel'
}): Promise<void> {
  if (await tryEnsureV1Auth(args.linkedAccountId)) return

  const credentialId = args.passkeyCredentialId?.trim()
  if (!credentialId) {
    throw new Error('V1 auth required — sign in with a passkey account first')
  }
  await signInWithPasskey({
    linkedAccountId: args.linkedAccountId,
    credentialId,
    surface: args.surface,
  })
  if (!(await tryEnsureV1Auth(args.linkedAccountId))) {
    throw new Error('V1 auth failed after sign-in')
  }
}

/** @deprecated Prefer `ensureV1Auth` — same behavior for cosign call sites. */
export async function ensureCosignV1Auth(args: {
  linkedAccountId: string
  passkeyCredentialId?: string
  surface: 'popup' | 'sidepanel'
}): Promise<void> {
  return ensureV1Auth(args)
}
