import React, { useEffect, useMemo, useRef, useState } from 'react'

import type { GetSwapQuoteRequest, GetSwapQuoteResponse } from '@latch/types'

import type { SwapDraft, SwapQuoteVm, SwapTokenVm } from '../swap/swapVm'
import {
  formatCompactAmount,
  parseBalanceAmount,
  pickDefaultReceiveTokenId,
  swapQuotePayloadToVm,
  toPositiveNumberOrNull,
} from '../swap/swapVm'
import { SwapDetails } from '../swap/components/SwapDetails'
import { TokenPickerModal } from '../swap/components/TokenPickerModal'
import { cancelBackgroundRequest, friendlyError, sendToBackground } from '../lib/backgroundClient'
import { createRequestId, shouldApplyBackgroundResult } from '../lib/requestSession'
import { SwapCardsStack } from './swap/components/SwapCardsStack'
import { SwapEnterAmountButton } from './swap/components/SwapEnterAmountButton'
import { SwapScreenHeader } from './swap/components/SwapScreenHeader'
import { MAIN_BOTTOM_NAV_CLEARANCE_PX } from './home/components/MainBottomNav'

const QUOTE_DEBOUNCE_MS = 400

export function SwapScreen({
  surface,
  accountId,
  walletLabel,
  initialState,
  onBack,
  onContinue,
  payTokenCatalog,
  receiveTokenCatalog,
  preferredReceiveTokenIds,
  tokenPriceUsdBySymbol,
}: {
  surface: 'popup' | 'sidepanel'
  accountId: string
  walletLabel: string
  initialState?: SwapDraft
  onBack: () => void
  onContinue: (quote: SwapQuoteVm, draft: SwapDraft) => void
  payTokenCatalog: SwapTokenVm[]
  receiveTokenCatalog: SwapTokenVm[]
  preferredReceiveTokenIds?: string[]
  tokenPriceUsdBySymbol?: Record<string, number>
}) {
  const defaultPayId = payTokenCatalog[0]?.id ?? ''
  const defaultReceiveId = pickDefaultReceiveTokenId(
    defaultPayId,
    receiveTokenCatalog,
    preferredReceiveTokenIds
  )

  const [payTokenId, setPayTokenId] = useState(initialState?.payTokenId ?? defaultPayId)
  const [receiveTokenId, setReceiveTokenId] = useState(
    initialState?.receiveTokenId ?? defaultReceiveId
  )
  const [payAmount, setPayAmount] = useState(initialState?.payAmount ?? '')
  const [useExchangeBalance, setUseExchangeBalance] = useState(
    initialState?.useExchangeBalance ?? false
  )
  const [pickerTarget, setPickerTarget] = useState<'pay' | 'receive' | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [previewQuote, setPreviewQuote] = useState<SwapQuoteVm | null>(null)

  const payToken = useMemo(
    () => payTokenCatalog.find((t) => t.id === payTokenId) ?? payTokenCatalog[0],
    [payTokenId, payTokenCatalog]
  )
  const receiveToken = useMemo(
    () =>
      receiveTokenCatalog.find((t) => t.id === receiveTokenId) ??
      receiveTokenCatalog.find((t) => t.id !== payToken?.id) ??
      receiveTokenCatalog[0],
    [receiveTokenId, receiveTokenCatalog, payToken?.id]
  )

  const payN = toPositiveNumberOrNull(payAmount)
  const payBalance = payToken ? parseBalanceAmount(payToken.balance) : 0
  const receiveBalance = receiveToken ? parseBalanceAmount(receiveToken.balance) : 0
  const insufficientBalance = payN !== null && payN > payBalance
  const canApprove =
    payN !== null && payN > 0 && !insufficientBalance && previewQuote !== null && !quoteLoading

  const draft: SwapDraft = useMemo(
    () => ({
      payTokenId: payToken?.id ?? payTokenId,
      receiveTokenId: receiveToken?.id ?? receiveTokenId,
      payAmount,
      useExchangeBalance,
      approved: canApprove,
    }),
    [canApprove, payAmount, payToken, payTokenId, receiveToken, receiveTokenId, useExchangeBalance]
  )

  const quoteRequestKey = useMemo(() => {
    if (!payToken || !receiveToken || payN === null || payN <= 0) return null
    return `${accountId}|${payToken.id}|${receiveToken.id}|${payAmount}`
  }, [accountId, payAmount, payN, payToken, receiveToken])

  const quoteSeqRef = useRef(0)
  const quoteRequestIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!quoteRequestKey || !payToken || !receiveToken) {
      if (quoteRequestIdRef.current) {
        void cancelBackgroundRequest(quoteRequestIdRef.current)
        quoteRequestIdRef.current = null
      }
      setPreviewQuote(null)
      setQuoteError(null)
      setQuoteLoading(false)
      return
    }

    const seq = ++quoteSeqRef.current
    setQuoteLoading(true)
    setQuoteError(null)

    const timer = setTimeout(() => {
      if (quoteRequestIdRef.current) {
        void cancelBackgroundRequest(quoteRequestIdRef.current)
      }
      const requestId = createRequestId()
      quoteRequestIdRef.current = requestId

      void (async () => {
        try {
          const res = await sendToBackground<GetSwapQuoteRequest, GetSwapQuoteResponse>({
            type: 'GET_SWAP_QUOTE',
            payload: {
              accountId,
              assetInId: payToken.id,
              assetOutId: receiveToken.id,
              amountIn: payAmount,
              requestId,
            },
          })
          if (seq !== quoteSeqRef.current) return
          if (
            !shouldApplyBackgroundResult({
              currentId: quoteRequestIdRef.current,
              responseId: requestId,
              error: res.error,
            })
          ) {
            return
          }
          if (!res.ok || !res.data) {
            setPreviewQuote(null)
            setQuoteError(friendlyError(res.error))
            return
          }
          const payUsd = tokenPriceUsdBySymbol?.[payToken.symbol.toUpperCase()]
          const receiveUsd = tokenPriceUsdBySymbol?.[receiveToken.symbol.toUpperCase()]
          setPreviewQuote(swapQuotePayloadToVm(res.data.quote, payUsd, receiveUsd))
          setQuoteError(null)
        } catch (e) {
          if (seq !== quoteSeqRef.current) return
          setPreviewQuote(null)
          setQuoteError(e instanceof Error ? e.message : String(e))
        } finally {
          if (seq === quoteSeqRef.current && quoteRequestIdRef.current === requestId) {
            setQuoteLoading(false)
          }
        }
      })()
    }, QUOTE_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      if (quoteRequestIdRef.current) {
        void cancelBackgroundRequest(quoteRequestIdRef.current)
        quoteRequestIdRef.current = null
      }
    }
  }, [accountId, payAmount, payToken, quoteRequestKey, receiveToken, tokenPriceUsdBySymbol])

  const payUsdPrice = payToken ? tokenPriceUsdBySymbol?.[payToken.symbol.toUpperCase()] : undefined
  const payUsdApprox =
    payN === null || payUsdPrice == null ? '≈--' : `≈$${(payN * payUsdPrice).toFixed(5)}`
  const receiveDisplayAmount = quoteLoading
    ? '…'
    : previewQuote === null
      ? '--'
      : formatCompactAmount(previewQuote.receiveAmount, 6)
  const receiveUsdApprox = previewQuote?.receiveUsdApprox ?? '≈--'

  const handleSwapTokens = () => {
    setPayTokenId(receiveTokenId)
    setReceiveTokenId(payTokenId)
  }

  const handleSelectToken = (tokenId: string) => {
    if (pickerTarget === 'pay') {
      if (tokenId === receiveTokenId) {
        handleSwapTokens()
      } else {
        setPayTokenId(tokenId)
      }
    } else if (pickerTarget === 'receive') {
      if (tokenId === payTokenId) {
        handleSwapTokens()
      } else {
        setReceiveTokenId(tokenId)
      }
    }
  }

  const pickerTokens = pickerTarget === 'pay' ? payTokenCatalog : receiveTokenCatalog

  const ctaLabel = canApprove ? 'Approve Swap' : 'Enter Amount'
  const ctaDisabled = payN === null || payN <= 0 || insufficientBalance || quoteLoading

  if (!payToken || !receiveToken) {
    return (
      <div className="p-4 text-sm text-muted">
        No swappable tokens in this account yet.
        <button type="button" className="mt-4 block text-primary" onClick={onBack}>
          Back
        </button>
      </div>
    )
  }

  return (
    <>
      <div
        className={[
          'flex min-h-0 flex-1 flex-col overflow-y-auto',
          surface === 'sidepanel' ? 'pt-2' : 'pt-3',
        ].join(' ')}
        style={{ paddingBottom: MAIN_BOTTOM_NAV_CLEARANCE_PX }}
      >
        <SwapScreenHeader onBack={onBack} />

        <div className="mt-4 flex flex-col gap-5">
          <div className="flex flex-col gap-8">
            <SwapCardsStack
              payToken={payToken}
              receiveToken={receiveToken}
              payBalance={payBalance}
              receiveBalance={receiveBalance}
              walletLabel={walletLabel}
              useExchangeBalance={useExchangeBalance}
              onExchangeBalanceChange={setUseExchangeBalance}
              onSwapDirection={handleSwapTokens}
              onPayTokenSelect={() => setPickerTarget('pay')}
              onReceiveTokenSelect={() => setPickerTarget('receive')}
              onAddFundsClick={() => {}}
              onMaxClick={() => setPayAmount(payToken.balance)}
              payUsdApprox={payUsdApprox}
              receiveUsdApprox={receiveUsdApprox}
              receiveMuted={!canApprove && !quoteLoading}
              receiveDisplayAmount={receiveDisplayAmount}
              payAmountInput={
                <input
                  inputMode="decimal"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="0.00"
                  className="box-border w-full min-w-0 bg-transparent text-right text-xl font-semibold tracking-[-0.4px] text-white outline-none placeholder:text-white"
                />
              }
            />

            {insufficientBalance ? (
              <p className="text-center text-xs text-red-400">Insufficient balance</p>
            ) : null}
            {quoteError ? <p className="text-center text-xs text-red-400">{quoteError}</p> : null}

            <SwapEnterAmountButton
              label={ctaLabel}
              disabled={ctaDisabled}
              onClick={() => {
                if (!canApprove || !previewQuote) return
                onContinue(previewQuote, { ...draft, approved: true })
              }}
            />
          </div>

          {previewQuote ? <SwapDetails quote={previewQuote} /> : null}
        </div>
      </div>

      <TokenPickerModal
        isOpen={pickerTarget !== null}
        onClose={() => setPickerTarget(null)}
        tokens={pickerTokens}
        selectedTokenId={pickerTarget === 'pay' ? payTokenId : receiveTokenId}
        onSelect={handleSelectToken}
      />
    </>
  )
}

export function swapWalletLabel(smartAccountAddress: string | undefined): string {
  if (!smartAccountAddress?.trim()) return 'My Wallet'
  const tail = smartAccountAddress.trim().slice(-4)
  return `My Wallet...${tail}`
}
