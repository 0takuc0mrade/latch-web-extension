import React from 'react'

import type { SwapTokenVm } from '../../../swap/swapVm'
import { SwapAmountColumn } from './SwapAmountColumn'
import { SwapTokenSelector } from './SwapTokenSelector'
import { SwapWalletRow } from './SwapWalletRow'

export function SwapTokenCard({
  token,
  variant,
  amountTop,
  amountBottom,
  mutedAmount,
  balance,
  walletLabel,
  onTokenSelect,
  onAddFundsClick,
  onMaxClick,
}: {
  token: SwapTokenVm
  variant: 'pay' | 'receive'
  amountTop: React.ReactNode
  amountBottom?: React.ReactNode
  mutedAmount?: boolean
  balance: number
  walletLabel: string
  onTokenSelect?: () => void
  onAddFundsClick?: () => void
  onMaxClick?: () => void
}) {
  const isPay = variant === 'pay'

  return (
    <div className="w-full rounded-[18px] bg-[#222121] px-3 py-4">
      <div className="flex w-full flex-col gap-5">
        <div className="relative z-20 flex w-full items-center justify-between gap-3">
          <div className="min-w-0 shrink">
            <SwapTokenSelector token={token} onSelect={onTokenSelect} />
          </div>
          <div className="min-w-0 flex-1 basis-0">
            <SwapAmountColumn top={amountTop} bottom={amountBottom} mutedTop={mutedAmount} />
          </div>
        </div>
        <SwapWalletRow
          walletLabel={walletLabel}
          balance={balance}
          showWalletPicker={isPay}
          showMax={isPay && balance > 0}
          showAddFunds={isPay && balance <= 0}
          onAddFundsClick={onAddFundsClick}
          onMaxClick={onMaxClick}
        />
      </div>
    </div>
  )
}
