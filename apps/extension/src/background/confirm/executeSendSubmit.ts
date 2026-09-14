import type {
  BuildSendTxRequest,
  BuildSendTxResponse,
  Network,
  SetupSendRulesRequest,
  StoredAccount,
  SubmitTxResponse,
} from '@latch/types'

import { BackendError, buildSendTx, setupSendRules } from '../backend'
import { getActiveNetwork } from '../network/config'
import { getAccounts } from '../storage'
import { signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'
import {
  buildSendRequestFromDraft,
  buildSetupRequestFromDraft,
  explainSendDraftNotBuildable,
  isBuildSendMissingSetupError,
  isNoContextRuleError,
  passkeySetupPrerequisiteError,
} from '../../ui/lib/sendTx'
import type { SendDraft } from '../../ui/types/send'

function errShape(e: unknown): { code?: string; status?: number; message?: string } {
  if (e instanceof BackendError) {
    return { code: e.code, status: e.status, message: e.message }
  }
  if (e instanceof Error) return { message: e.message }
  return { message: String(e) }
}

function extractTransactionHash(data: SubmitTxResponse | null | undefined): string | undefined {
  if (!data) return undefined
  if (typeof data.transactionHash === 'string') return data.transactionHash
  if (typeof data.hash === 'string') return data.hash
  return undefined
}

async function ensureSendRulesConfigured(args: {
  setupBody: SetupSendRulesRequest
  activeAccount: StoredAccount
}): Promise<'configured' | 'already_configured'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const network = args.setupBody.network ?? (await getActiveNetwork())
    const setup = await setupSendRules({ ...args.setupBody, network })
    if (setup.alreadyConfigured) return 'already_configured'
    await signAndSubmitBuiltTxInBackground({
      build: setup,
      activeAccount: args.activeAccount,
    })
    if ((setup.remainingSetupCount ?? 0) <= 0) return 'configured'
  }
  throw new Error('Send setup did not complete')
}

export async function executeSendSubmitInBackground(args: {
  accountId: string
  draft: SendDraft
  sendTokenPriceUsd: number | null
  network: Network
}): Promise<{ status: 'success'; hash?: string; submittedAt: string }> {
  const { accounts } = await getAccounts()
  const account = accounts.find((a) => a.id === args.accountId)
  if (!account) throw new Error('No active account')

  const buildBody = buildSendRequestFromDraft(
    args.draft,
    account,
    args.sendTokenPriceUsd,
    args.network
  )
  if (!buildBody) {
    throw new Error(
      explainSendDraftNotBuildable(args.draft, account, args.sendTokenPriceUsd) ??
        'Invalid send details'
    )
  }

  let configuredSendRulesInLoop = false
  for (let attempt = 0; attempt < 5; attempt++) {
    let build: BuildSendTxResponse
    try {
      const network = buildBody.network ?? (await getActiveNetwork())
      build = await buildSendTx({ ...(buildBody as BuildSendTxRequest), network })
    } catch (e) {
      const shape = errShape(e)
      if (isBuildSendMissingSetupError(shape)) {
        const setupBody = buildSetupRequestFromDraft(args.draft, account, undefined, args.network)
        if (!setupBody) {
          throw new Error(
            passkeySetupPrerequisiteError(account) ??
              'Cannot set up send rules for this account. Sign in with your passkey again.'
          )
        }
        const setupResult = await ensureSendRulesConfigured({
          setupBody,
          activeAccount: account,
        })
        if (setupResult === 'configured') configuredSendRulesInLoop = true
        if (
          setupResult === 'already_configured' &&
          !configuredSendRulesInLoop &&
          !isNoContextRuleError(shape)
        ) {
          throw e instanceof Error ? e : new Error(String(e))
        }
        continue
      }
      throw e instanceof Error ? e : new Error(String(e))
    }

    const submitData = await signAndSubmitBuiltTxInBackground({
      build,
      activeAccount: account,
    })
    return {
      status: 'success',
      hash: extractTransactionHash(submitData),
      submittedAt: new Date().toISOString(),
    }
  }

  throw new Error('Send setup did not complete')
}
