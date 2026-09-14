import React from 'react'

export function SwapAmountColumn({
  top,
  bottom,
  mutedTop,
}: {
  top: React.ReactNode
  bottom?: React.ReactNode
  mutedTop?: boolean
}) {
  return (
    <div className="flex w-full min-w-0 flex-col items-end justify-center gap-2 text-right">
      <div
        className={[
          'w-full min-w-0 text-xl font-semibold tracking-[-0.4px]',
          mutedTop ? 'text-muted' : 'text-white',
        ].join(' ')}
      >
        {top}
      </div>
      {bottom != null ? (
        <div className="w-full min-w-0 text-sm tracking-[-0.28px] text-muted">{bottom}</div>
      ) : null}
    </div>
  )
}
