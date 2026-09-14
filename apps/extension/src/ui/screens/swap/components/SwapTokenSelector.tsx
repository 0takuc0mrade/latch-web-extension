import React from 'react'

import chevronDownIconUrl from 'url:../../../../../assets/home/icon-chevron-down.svg'
import type { SwapTokenVm } from '../../../swap/swapVm'
import { SwapTokenAvatar } from './SwapTokenAvatar'

function tokenSubtitle(token: SwapTokenVm): string {
  if (token.name === 'Tether' || token.symbol.toUpperCase() === 'USDT') return 'Tether USDT'
  return token.name
}

export function SwapTokenSelector({
  token,
  onSelect,
}: {
  token: SwapTokenVm
  onSelect?: () => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.()}
      className="relative z-20 flex min-w-0 cursor-pointer items-center gap-2 text-left"
    >
      <SwapTokenAvatar token={token} />
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-lg font-semibold tracking-[-0.36px] text-[#fcfcfc]">
            {token.name}
          </span>
          <img src={chevronDownIconUrl} alt="" className="size-6 shrink-0" aria-hidden />
        </div>
        <span className="truncate text-sm tracking-[-0.28px] text-muted">
          {tokenSubtitle(token)}
        </span>
      </div>
    </button>
  )
}
