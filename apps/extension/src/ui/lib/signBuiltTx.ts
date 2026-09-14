import type {
  BuildSendTxResponse,
  SignDelegatedGAuthEntryRequest,
  SignDelegatedGAuthEntryResponse,
  StoredAccount,
  SubmitDelegatedTxRequest,
  SubmitTxResponse,
  SubmitWebauthnTxRequest,
} from '@latch/types'

import { resolveDelegatedAuthEntryForSigner } from '../../lib/delegatedAuthSubmit'
import {
  contextRuleIdForSubmit,
  delegatedSubmitFields,
  isDelegatedSendBuild,
  normalizeDelegatedBuildFields,
} from '../../lib/sendBuildFields'
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
  const progress = args.onProgress ?? (() => {})
  const submit = args.submit
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

  progress('Signing…')
  const signRes = await sendToBackground<
    {
      accountId: string
      signingAccountId?: string
      build: BuildSendTxResponse
      submit?: boolean
      surface?: 'popup' | 'sidepanel'
    },
    SubmitTxResponse
  >({
    type: 'SIGN_PASSKEY_BUILT_TX',
    payload: {
      accountId: activeAccount.id,
      signingAccountId: args.signingAccount?.id,
      build,
      submit,
      surface: args.surface,
    },
  })
  if (!signRes.ok) throw new Error(friendlyError(signRes.error))
  progress(submit === false ? 'Preparing…' : 'Submitting…')
  return signRes.data ?? {}
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

// Re-export for callers that imported submit field helpers via this module historically.
export type { SubmitWebauthnTxRequest }
