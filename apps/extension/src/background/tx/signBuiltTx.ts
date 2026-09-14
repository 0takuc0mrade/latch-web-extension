import type { BuildSendTxResponse, StoredAccount, SubmitTxResponse } from '@latch/types'

import { resolveDelegatedAuthEntryForSigner } from '../../lib/delegatedAuthSubmit'
import {
  contextRuleIdForSubmit,
  delegatedSubmitFields,
  isDelegatedSendBuild,
  multiAuthSubmitFields,
  normalizeDelegatedBuildFields,
  resolvePasskeyAuthEntryXdr,
} from '../../lib/sendBuildFields'
import {
  assertPasskeyAssertionMatchesAuthDigest,
  buildPasskeySigDataXdrFromAssertion,
  enrichWebauthnRpIdHashErrorMessage,
  passkeyAuthenticationOptionsForAuthDigest,
} from '../../ui/webauthn/passkey'
import { submitTxDelegated, submitTxWebauthn } from '../backend'
import { signDelegatedGAddressEntry } from '../delegatedLocalSign'
import { getMnemonicKeypair } from '../mnemonicSession'
import { getActiveNetwork, networkPassphraseFor } from '../network/config'
import { getAccounts } from '../storage'
import {
  maybeProbeDelegatedEnforcingSim,
  maybeProbeWebauthnEnforcingSim,
} from '../tx/enforcingSimProbe'
import { runPasskeyBridgeAndWait } from '../webauthn/passkeyBridge'

export type SignBuiltTxArgs = {
  build: BuildSendTxResponse
  activeAccount: StoredAccount
  signingAccount?: StoredAccount
  submit?: boolean
}

async function signPasskeyPath(args: SignBuiltTxArgs): Promise<SubmitTxResponse> {
  const { build: rawBuild, activeAccount } = args
  const build = normalizeDelegatedBuildFields(rawBuild)
  const submit = args.submit
  const passkeySource =
    activeAccount.mode === 'multisig' ? (args.signingAccount ?? activeAccount) : activeAccount

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

  const assertion = await runPasskeyBridgeAndWait({
    mode: 'authentication',
    optionsJSON,
  })
  assertPasskeyAssertionMatchesAuthDigest(assertion, build.authDigestHex)
  const sigDataXdr = buildPasskeySigDataXdrFromAssertion(assertion)

  const req = {
    txXdr: build.txXdr,
    authEntryXdr: resolvePasskeyAuthEntryXdr(build),
    sigDataXdr,
    keyDataHex: passkeySource.passkeyKeyDataHex,
    contextRuleId: contextRuleIdForSubmit(build),
    submit,
    ...multiAuthSubmitFields(build),
  }
  maybeProbeWebauthnEnforcingSim(req)
  try {
    return await submitTxWebauthn(req)
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    throw new Error(
      await enrichWebauthnRpIdHashErrorMessage(errMsg, {
        optionsJSON,
        credentialResponse: assertion,
      })
    )
  }
}

async function signDelegatedPath(args: SignBuiltTxArgs): Promise<SubmitTxResponse> {
  const { build: rawBuild, activeAccount } = args
  const build = normalizeDelegatedBuildFields(rawBuild)
  const submit = args.submit
  const network = await getActiveNetwork()
  const networkPassphrase = networkPassphraseFor(network)

  if (!isDelegatedSendBuild(build)) {
    throw new Error('Delegated submit requires a delegated auth entry in the build.')
  }

  const delegated = resolveDelegatedAuthEntryForSigner({
    authEntriesXdr: build.authEntriesXdr,
    delegatedNativeAuthEntryIndices: build.delegatedNativeAuthEntryIndices,
    gAddressEntryTemplateXdr: build.gAddressEntryTemplateXdr,
    signerG: activeAccount.gAddress ?? '',
  })
  if (!delegated) {
    throw new Error('Could not find delegated auth entry for this account in the transaction.')
  }

  const kp = getMnemonicKeypair(activeAccount.id)
  if (!kp) {
    throw new Error(
      'Seed signer is not loaded. Re-open the wallet and unlock with your encryption password if you enabled Remember.'
    )
  }

  const signed = await signDelegatedGAddressEntry({
    gAddressEntryTemplateXdr: delegated.templateXdr,
    signer: kp,
    networkPassphrase,
  })

  const req = {
    txXdr: build.txXdr,
    smartAccountAuthEntryXdr: build.smartAccountAuthEntryXdr!,
    gAddressEntryTemplateXdr: delegated.templateXdr,
    signedAuthEntryBase64: signed.signedAuthEntryBase64,
    signerAddress: signed.signerAddress,
    contextRuleId: contextRuleIdForSubmit(build),
    submit,
    ...delegatedSubmitFields(build, delegated.entryIndex),
  }
  maybeProbeDelegatedEnforcingSim(req)
  return await submitTxDelegated(req)
}

/** Sign + submit (or assemble) a built tx from the service worker. */
export async function signAndSubmitBuiltTxInBackground(
  args: SignBuiltTxArgs
): Promise<SubmitTxResponse> {
  const { activeAccount } = args
  const build = normalizeDelegatedBuildFields(args.build)

  if (activeAccount.mode === 'mnemonic' && isDelegatedSendBuild(build)) {
    return signDelegatedPath({ ...args, build })
  }
  return signPasskeyPath({ ...args, build })
}

export async function resolveAccountsForSign(args: {
  accountId: string
  signingAccountId?: string
}): Promise<{ activeAccount: StoredAccount; signingAccount?: StoredAccount }> {
  const { accounts } = await getAccounts()
  const activeAccount = accounts.find((a) => a.id === args.accountId)
  if (!activeAccount) throw new Error('Account not found.')
  const signingAccount = args.signingAccountId
    ? accounts.find((a) => a.id === args.signingAccountId)
    : undefined
  return { activeAccount, signingAccount }
}
