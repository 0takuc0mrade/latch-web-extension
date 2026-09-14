import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  BuildSendTxRequest,
  BuildSendTxResponse,
  GetMarketPricesRequest,
  GetMarketPricesResponse,
  SmartAccountBalanceRow,
  StoredAccount,
} from '@latch/types'

import { SendFlow } from '../screens/send/SendFlow'
import { saveToAddressBook } from '../screens/send/useAddressBook'
import { executeSendWithSetupLoop } from '../lib/executeSend'
import { createMultisigSendProposalWithSetup } from '../lib/multisigProposal'
import { enrichSendFailureDetail, buildSendRequestFromDraft } from '../lib/sendTx'
import { sendToBackground } from '../lib/backgroundClient'
import { INITIAL_SEND_DRAFT, type SendDraft, type SendResult, type SendStep } from '../types/send'
import type { Route, Surface } from '../routing/routes'
import { consumePendingWebauthnFlowIf, ensureDurableWalletUi } from '../webauthn/durableWalletUi'

export function SendRouteViews({
  route,
  surface,
  activeAccount,
  accounts,
  activeNetwork,
  networkLabel,
  portfolioRows,
  portfolioLoading,
  portfolioError,
  routeContentMarginClass,
  flowHeightClass,
  loading,
  onSetRoute,
  onLoadPortfolio,
  onLoadMultisigProposals,
  onSetMultisigDetailProposalId,
  registerOpenSend,
}: {
  route: Route | string
  surface: Surface
  activeAccount: StoredAccount | undefined
  accounts: StoredAccount[]
  activeNetwork: 'testnet' | 'mainnet'
  networkLabel: string
  portfolioRows: SmartAccountBalanceRow[]
  portfolioLoading: boolean
  portfolioError: string | null
  routeContentMarginClass: string
  flowHeightClass: string
  loading: string | null
  onSetRoute: (route: Route) => void
  onLoadPortfolio: () => void
  onLoadMultisigProposals: () => void
  onSetMultisigDetailProposalId: (id: string) => void
  registerOpenSend?: (open: () => void) => void
}) {
  const [sendStep, setSendStep] = useState<SendStep>('selectToken')
  const [sendDraft, setSendDraft] = useState<SendDraft>(INITIAL_SEND_DRAFT)
  const [sendResult, setSendResult] = useState<SendResult | null>(null)
  const [sendProgressLabel, setSendProgressLabel] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendTokenPriceUsd, setSendTokenPriceUsd] = useState<number | null>(null)
  const [autoResumeSend, setAutoResumeSend] = useState(false)
  const skipDurableHandoffRef = useRef(false)

  function resetSendFlow() {
    setSendDraft(INITIAL_SEND_DRAFT)
    setSendStep('selectToken')
    setSendResult(null)
    setSendError(null)
    setSendProgressLabel(null)
    setSendTokenPriceUsd(null)
  }

  const openSendFlow = useCallback(() => {
    resetSendFlow()
    onSetRoute('send')
    void onLoadPortfolio()
  }, [onSetRoute, onLoadPortfolio])

  useLayoutEffect(() => {
    registerOpenSend?.(openSendFlow)
  }, [registerOpenSend, openSendFlow])

  const loadMarketPriceForToken = useCallback(async (code: string): Promise<number | null> => {
    const res = await sendToBackground<GetMarketPricesRequest, GetMarketPricesResponse>({
      type: 'GET_MARKET_PRICES',
      payload: { tokens: [code] },
    })
    if (!res.ok || !res.data) return null
    return res.data.pricesByCodeUpper[code.toUpperCase()]?.priceUsd ?? null
  }, [])

  useEffect(() => {
    if (route !== 'send') return
    const code = sendDraft.token?.code?.trim()
    if (!code) {
      setSendTokenPriceUsd(null)
      return
    }
    let cancelled = false
    void loadMarketPriceForToken(code).then((p) => {
      if (!cancelled) setSendTokenPriceUsd(p)
    })
    return () => {
      cancelled = true
    }
  }, [route, sendDraft.token?.code, loadMarketPriceForToken])

  const fetchSendFeeEstimate = useCallback(async (): Promise<BuildSendTxResponse | null> => {
    if (!activeAccount || activeAccount.mode === 'multisig') return null
    const buildBody = buildSendRequestFromDraft(
      sendDraft,
      activeAccount,
      sendTokenPriceUsd,
      activeNetwork
    )
    if (!buildBody) return null
    try {
      const buildRes = await sendToBackground<BuildSendTxRequest, BuildSendTxResponse>({
        type: 'BUILD_SEND_TX',
        payload: buildBody,
      })
      if (buildRes.ok && buildRes.data) return buildRes.data
      return null
    } catch {
      return null
    }
  }, [activeAccount, sendDraft, sendTokenPriceUsd, activeNetwork])

  async function handleSubmitSend() {
    if (!skipDurableHandoffRef.current) {
      try {
        const handoff = await ensureDurableWalletUi({
          surface,
          pending: {
            version: 1,
            kind: 'sendSubmit',
            route: 'send',
            autoResume: true,
            createdAt: Date.now(),
            draft: sendDraft,
            sendStep: 'summary',
            sendTokenPriceUsd,
          },
        })
        if (handoff.relocated) return
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setSendResult({
          status: 'failure',
          errorMessage: message,
          submittedAt: new Date().toISOString(),
        })
        setSendStep('failure')
        return
      }
    }
    skipDurableHandoffRef.current = false

    setSendError(null)
    setSendProgressLabel('Building…')
    try {
      if (activeAccount?.mode === 'multisig') {
        const proposal = await createMultisigSendProposalWithSetup({
          draft: sendDraft,
          multisigAccount: activeAccount,
          accounts,
          priceUsd: sendTokenPriceUsd,
          surface,
          onProgress: setSendProgressLabel,
        })
        setSendResult({
          status: 'success',
          proposalId: proposal.id,
          submittedAt: new Date().toISOString(),
        })
        onSetMultisigDetailProposalId(proposal.id)
        setSendStep('success')
        void onLoadPortfolio()
        void onLoadMultisigProposals()
        return
      }

      if (!activeAccount) throw new Error('No active account')
      const result = await executeSendWithSetupLoop({
        draft: sendDraft,
        activeAccount,
        sendTokenPriceUsd,
        activeNetwork,
        surface,
        onProgress: setSendProgressLabel,
      })
      setSendResult(result)
      setSendStep('success')
      if (result.status === 'success') {
        void saveToAddressBook({
          address: sendDraft.recipientAddress,
          name: sendDraft.recipientName,
        }).catch(() => {})
      }
      void onLoadPortfolio()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[latch:send]', message, e)
      const errorMessage = await enrichSendFailureDetail({
        errorMessage: message,
        draft: sendDraft,
        network: activeNetwork,
      })
      setSendResult({
        status: 'failure',
        errorMessage,
        submittedAt: new Date().toISOString(),
      })
      setSendStep('failure')
    } finally {
      setSendProgressLabel(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const pending = await consumePendingWebauthnFlowIf('sendSubmit')
      if (cancelled || !pending || !pending.autoResume) return
      setSendDraft(pending.draft)
      setSendStep(pending.sendStep)
      setSendTokenPriceUsd(pending.sendTokenPriceUsd)
      onSetRoute('send')
      setAutoResumeSend(true)
    })()
    return () => {
      cancelled = true
    }
  }, [onSetRoute])

  useEffect(() => {
    if (!autoResumeSend || sendStep !== 'summary' || !activeAccount) return
    // Wait until draft looks submit-ready (token + amount + recipient).
    if (!sendDraft.token || !sendDraft.amount.trim() || !sendDraft.recipientAddress.trim()) return
    setAutoResumeSend(false)
    skipDurableHandoffRef.current = true
    void handleSubmitSend()
  }, [autoResumeSend, sendStep, sendDraft, activeAccount])

  if (loading || route !== 'send') return null

  return (
    <div
      className={[
        `${routeContentMarginClass} flex min-h-0 flex-1 flex-col animate-screenIn`,
        flowHeightClass,
      ].join(' ')}
    >
      <SendFlow
        surface={surface}
        step={sendStep}
        draft={sendDraft}
        result={sendResult}
        portfolioRows={portfolioRows}
        portfolioLoading={portfolioLoading}
        portfolioError={portfolioError}
        tokenPriceUsd={sendTokenPriceUsd}
        networkLabel={networkLabel}
        network={activeNetwork}
        sendProgressLabel={sendProgressLabel}
        sendError={sendError}
        createProposalMode={activeAccount?.mode === 'multisig'}
        onDraftChange={(patch) => setSendDraft((d) => ({ ...d, ...patch }))}
        onStepChange={setSendStep}
        onBackFromSend={() => {
          resetSendFlow()
          onSetRoute('home')
        }}
        onFetchFeeEstimate={fetchSendFeeEstimate}
        onSubmitSend={() => void handleSubmitSend()}
        onContinueHome={() => {
          if (sendResult?.proposalId && activeAccount?.mode === 'multisig') {
            onSetMultisigDetailProposalId(sendResult.proposalId)
            resetSendFlow()
            onSetRoute('multisigProposalDetail')
            return
          }
          resetSendFlow()
          onSetRoute('home')
        }}
        onTryAgainFromFailure={() => {
          setSendError(sendResult?.errorMessage ?? null)
          setSendStep('summary')
        }}
      />
    </div>
  )
}
