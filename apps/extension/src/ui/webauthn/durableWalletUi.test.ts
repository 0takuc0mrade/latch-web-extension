import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChromeMock } from '../../test/chromeMock'
import {
  PENDING_WEBAUTHN_FLOW_KEY,
  PENDING_WEBAUTHN_FLOW_TTL_MS,
  consumePendingWebauthnFlowIf,
  ensureDurableWalletUi,
  isDurableWalletUi,
  isEphemeralActionPopup,
  isPendingWebauthnFlowFresh,
  readPendingWebauthnFlow,
  writePendingWebauthnFlow,
} from './durableWalletUi'

describe('durableWalletUi', () => {
  beforeEach(() => {
    const mock = createChromeMock()
    globalThis.chrome = mock as unknown as typeof chrome
    vi.stubGlobal('window', {
      location: { search: '', href: 'chrome-extension://test/popup.html', hash: '' },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('isPendingWebauthnFlowFresh respects TTL', () => {
    const now = 1_000_000
    expect(isPendingWebauthnFlowFresh({ createdAt: now - 1000 }, now)).toBe(true)
    expect(
      isPendingWebauthnFlowFresh({ createdAt: now - PENDING_WEBAUTHN_FLOW_TTL_MS - 1 }, now)
    ).toBe(false)
    expect(isPendingWebauthnFlowFresh(null, now)).toBe(false)
  })

  it('isDurableWalletUi detects durable=1 query', () => {
    vi.stubGlobal('window', {
      location: {
        search: '?durable=1',
        href: 'chrome-extension://test/popup.html?durable=1',
        hash: '',
      },
    })
    expect(isDurableWalletUi()).toBe(true)
  })

  it('isEphemeralActionPopup is false for sidepanel and durable popup windows', async () => {
    expect(await isEphemeralActionPopup('sidepanel')).toBe(false)
    ;(chrome as any).__setCurrentWindow({ id: 2, type: 'popup' })
    expect(await isEphemeralActionPopup('popup')).toBe(false)
  })

  it('isEphemeralActionPopup is true for toolbar action popup', async () => {
    ;(chrome as any).__setCurrentWindow({ id: 1, type: 'normal' })
    expect(await isEphemeralActionPopup('popup')).toBe(true)
  })

  it('ensureDurableWalletUi no-ops when not ephemeral', async () => {
    const result = await ensureDurableWalletUi({
      surface: 'sidepanel',
      pending: {
        version: 1,
        kind: 'dappApproval',
        route: 'dappApproval',
        autoResume: true,
        createdAt: Date.now(),
      },
    })
    expect(result).toEqual({ relocated: false })
  })

  it('ensureDurableWalletUi writes pending and opens durable window', async () => {
    ;(chrome as any).__setCurrentWindow({ id: 1, type: 'normal' })
    const pending = {
      version: 1 as const,
      kind: 'dappApproval' as const,
      route: 'dappApproval' as const,
      autoResume: true as const,
      createdAt: Date.now(),
    }
    const result = await ensureDurableWalletUi({ surface: 'popup', pending })
    expect(result.relocated).toBe(true)
    const stored = await readPendingWebauthnFlow()
    expect(stored?.kind).toBe('dappApproval')
  })

  it('consumePendingWebauthnFlowIf only clears matching kind', async () => {
    await writePendingWebauthnFlow({
      version: 1,
      kind: 'swapConfirm',
      route: 'swapConfirm',
      autoResume: true,
      createdAt: Date.now(),
      draft: {
        payTokenId: 'a',
        receiveTokenId: 'b',
        payAmount: '1',
        useExchangeBalance: false,
        approved: true,
      },
      quote: {
        provider: 'test',
        rateLine: '',
        slippageLine: '',
        minReceivedLine: '',
        networkFeeLine: '',
        receiveAmount: 1,
        receiveUsdApprox: '',
        receiveAmountLine: '',
        receiveUsdApproxLine: '',
        quotePayload: {
          providerId: 'mock',
          amountInRaw: '1',
          amountOutRaw: '1',
          amountOutMinRaw: '1',
          slippageBps: 50,
          expiresAtMs: Date.now() + 60_000,
          assetIn: {
            id: 'a',
            symbol: 'XLM',
            name: 'XLM',
            assetId: 'native',
            contractId: 'C',
            decimals: 7,
          },
          assetOut: {
            id: 'b',
            symbol: 'USDC',
            name: 'USDC',
            assetId: 'usdc',
            contractId: 'C2',
            decimals: 7,
          },
        } as any,
      },
    })

    const send = await consumePendingWebauthnFlowIf('sendSubmit')
    expect(send).toBeNull()
    const still = await chrome.storage.session.get(PENDING_WEBAUTHN_FLOW_KEY)
    expect(still[PENDING_WEBAUTHN_FLOW_KEY]).toBeTruthy()

    const swap = await consumePendingWebauthnFlowIf('swapConfirm')
    expect(swap?.kind).toBe('swapConfirm')
    const gone = await chrome.storage.session.get(PENDING_WEBAUTHN_FLOW_KEY)
    expect(gone[PENDING_WEBAUTHN_FLOW_KEY]).toBeUndefined()
  })
})
