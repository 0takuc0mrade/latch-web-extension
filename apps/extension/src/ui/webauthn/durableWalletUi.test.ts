/** Legacy durable handoff tests removed — see `lib/walletOutcome.test.ts`. */
import { describe, expect, it } from 'vitest'

import { ensureDurableWalletUi, isDurableHandoffActive } from './durableWalletUi'

describe('durableWalletUi (retired handoff)', () => {
  it('ensureDurableWalletUi is a no-op', async () => {
    await expect(ensureDurableWalletUi({})).resolves.toEqual({ relocated: false })
  })

  it('isDurableHandoffActive is always false', async () => {
    await expect(isDurableHandoffActive()).resolves.toBe(false)
  })
})
