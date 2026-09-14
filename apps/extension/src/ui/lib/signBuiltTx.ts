import type {
  BuildSendTxResponse,
  SignDelegatedGAuthEntryRequest,
  SignDelegatedGAuthEntryResponse,
  StoredAccount,
  SubmitDelegatedTxRequest,
  SubmitTxResponse,
  SubmitWebauthnTxRequest,
} from '@latch/types'

import type { startAuthentication } from '@simplewebauthn/browser'

import { resolveDelegatedAuthEntryForSigner } from '../../lib/delegatedAuthSubmit'
import {
  assertPasskeyAssertionMatchesAuthDigest,
  buildPasskeySigDataXdrFromAssertion,
  enrichWebauthnRpIdHashErrorMessage,
  passkeyAuthenticationOptionsForAuthDigest,
} from '../webauthn/passkey'
import { runWebauthnCredential } from '../webauthn/runWebauthnCredential'
import {
  contextRuleIdForSubmit,
  delegatedSubmitFields,
  isDelegatedSendBuild,
  multiAuthSubmitFields,
  normalizeDelegatedBuildFields,
  resolvePasskeyAuthEntryXdr,
} from './sendTx'
import { friendlyError, sendToBackground } from './backgroundClient'
import { fetchActiveNetwork, networkPassphraseFor } from './activeNetwork'

export function extractTransactionHash(
  data: SubmitTxResponse | null | undefined
): string | undefined {
  if (!data) return undefined
  if (typeof data.transactionHash === 'string') return data.transactionHash
  if (typeof data.hash === 'string') return data.hash
  return undefined
}

export function extractSignedTxXdr(data: SubmitTxResponse | null | undefined): string | undefined {
  if (!data) return undefined
  if (typeof data.signedTxXdr === 'string') return data.signedTxXdr
  return undefined
}

async function runPasskeyAuth(
  surface: 'popup' | 'sidepanel',
  optionsJSON: unknown
): Promise<Awaited<ReturnType<typeof startAuthentication>>> {
  return (await runWebauthnCredential(surface, 'authentication', optionsJSON)) as Awaited<
    ReturnType<typeof startAuthentication>
  >
}

export async function signAndSubmitBuiltTx(args: {
  build: BuildSendTxResponse
  activeAccount: StoredAccount
  /** When `activeAccount.mode === 'multisig'`, passkey credentials from this account. */
  signingAccount?: StoredAccount
  surface?: 'popup' | 'sidepanel'
  onProgress?: (label: string) => void
  /**
   * When false, the backend signs + assembles but does not broadcast; the
   * response carries `signedTxXdr` so the caller can submit via RPC itself.
   * Defaults to true.
   */
  submit?: boolean
}): Promise<SubmitTxResponse> {
  const { build: rawBuild, activeAccount } = args
  const build = normalizeDelegatedBuildFields(rawBuild)
  const surface = args.surface ?? 'popup'
  const progress = args.onProgress ?? (() => {})
  const submit = args.submit
  const passkeySource =
    activeAccount.mode === 'multisig' ? (args.signingAccount ?? activeAccount) : activeAccount
  const { network } = await fetchActiveNetwork()
  const networkPassphrase = networkPassphraseFor(network)

  if (activeAccount.mode === 'mnemonic' && isDelegatedSendBuild(build)) {
    const delegated = resolveDelegatedAuthEntryForSigner({
      authEntriesXdr: build.authEntriesXdr,
      delegatedNativeAuthEntryIndices: build.delegatedNativeAuthEntryIndices,
      gAddressEntryTemplateXdr: build.gAddressEntryTemplateXdr,
      signerG: activeAccount.gAddress ?? '',
    })
    if (!delegated) {
      throw new Error('Could not find delegated auth entry for this account in the transaction.')
    }

    const signRes = await sendToBackground<
      SignDelegatedGAuthEntryRequest,
      SignDelegatedGAuthEntryResponse
    >({
      type: 'SIGN_DELEGATED_G_AUTH_ENTRY',
      payload: {
        accountId: activeAccount.id,
        gAddressEntryTemplateXdr: delegated.templateXdr,
        networkPassphrase,
      },
    })
    if (!signRes.ok) throw new Error(friendlyError(signRes.error))
    progress(submit === false ? 'Preparing…' : 'Submitting…')
    const submitRes = await sendToBackground<SubmitDelegatedTxRequest, SubmitTxResponse>({
      type: 'SUBMIT_TX_DELEGATED',
      payload: {
        txXdr: build.txXdr,
        smartAccountAuthEntryXdr: build.smartAccountAuthEntryXdr!,
        gAddressEntryTemplateXdr: delegated.templateXdr,
        signedAuthEntryBase64: signRes.data!.signedAuthEntryBase64,
        signerAddress: signRes.data!.signerAddress,
        contextRuleId: contextRuleIdForSubmit(build),
        submit,
        ...delegatedSubmitFields(build, delegated.entryIndex),
      },
    })
    if (!submitRes.ok) throw new Error(friendlyError(submitRes.error))
    return submitRes.data ?? {}
  }

  if (!passkeySource.passkeyCredentialId || !passkeySource.passkeyKeyDataHex) {
    throw new Error(
      activeAccount.mode === 'multisig'
        ? 'No passkey account is available to sign for this multisig wallet. Sign in with your Latch passkey, then try again.'
        : 'This account is missing its passkey signing data on this device. Log out and sign in again with your Latch passkey to restore it, then retry.'
    )
  }
  if (
    isDelegatedSendBuild(build) &&
    (build.submitMethod === 'delegated' || build.submitMethod === 'bundler-delegated')
  ) {
    throw new Error(
      'This smart account authorizes swaps via a delegated G-address, not your passkey. ' +
        'Import the seed phrase for the delegated signer G-address, or log out and sign in with passkey to run one-time swap setup.'
    )
  }
  if (!build.authDigestHex?.trim()) {
    throw new Error('Missing auth digest from transaction build.')
  }
  const optionsJSON = passkeyAuthenticationOptionsForAuthDigest({
    credentialId: passkeySource.passkeyCredentialId,
    authDigestHex: build.authDigestHex,
  })
  progress('Signing…')
  const assertion = await runPasskeyAuth(surface, optionsJSON)
  assertPasskeyAssertionMatchesAuthDigest(assertion, build.authDigestHex)
  const sigDataXdr = buildPasskeySigDataXdrFromAssertion(assertion)
  progress(submit === false ? 'Preparing…' : 'Submitting…')
  const submitRes = await sendToBackground<SubmitWebauthnTxRequest, SubmitTxResponse>({
    type: 'SUBMIT_TX_WEBAUTHN',
    payload: {
      txXdr: build.txXdr,
      authEntryXdr: resolvePasskeyAuthEntryXdr(build),
      sigDataXdr,
      keyDataHex: passkeySource.passkeyKeyDataHex,
      contextRuleId: contextRuleIdForSubmit(build),
      submit,
      ...multiAuthSubmitFields(build),
    },
  })
  if (!submitRes.ok) {
    const errMsg = friendlyError(submitRes.error)
    throw new Error(
      await enrichWebauthnRpIdHashErrorMessage(errMsg, {
        optionsJSON,
        credentialResponse: assertion,
      })
    )
  }
  return submitRes.data ?? {}
}

/**
 * Sign a built transaction without broadcasting it. Runs the same signer flow
 * as {@link signAndSubmitBuiltTx} but asks the backend for a submit-ready
 * `signedTxXdr` (submit=false), so the caller (e.g. a dApp) can submit via RPC.
 */
export async function signWithoutSubmitBuiltTx(
  args: Omit<Parameters<typeof signAndSubmitBuiltTx>[0], 'submit'>
): Promise<{ signedTxXdr?: string; signedAuthEntry?: string }> {
  const res = await signAndSubmitBuiltTx({ ...args, submit: false })
  const signedTxXdr = extractSignedTxXdr(res)
  const signedAuthEntry = typeof res.signedAuthEntry === 'string' ? res.signedAuthEntry : undefined
  return { signedTxXdr, signedAuthEntry }
}
