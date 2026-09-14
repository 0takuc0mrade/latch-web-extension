import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChromeMock } from '../../test/chromeMock'
import {
  openPasskeyBridgeAndWait,
  passkeyBridgeResultStorageKey,
  publishPasskeyBridgeResult,
} from './passkeyBridge'

describe('passkeyBridge', () => {
  beforeEach(() => {
    const mock = createChromeMock()
    globalThis.chrome = mock as unknown as typeof chrome
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000001' as `${string}-${string}-${string}-${string}-${string}`
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('resolves when result is published via storage fallback', async () => {
    const ticket = '00000000-0000-4000-8000-000000000001'
    const waiter = openPasskeyBridgeAndWait({
      mode: 'authentication',
      optionsJSON: { challenge: 'abc', rpId: 'example.com' },
      timeoutMs: 5_000,
    })

    // Allow request write + window create callbacks to run.
    await vi.waitFor(async () => {
      const bag = await chrome.storage.session.get(`latchPasskeyBridgeReq:${ticket}`)
      // Request key is removed only after bridge reads it; it should exist briefly,
      // or window create already ran. Either way, publish should settle the waiter.
      void bag
      return true
    })

    await publishPasskeyBridgeResult({
      ticket,
      ok: true,
      response: { id: 'cred' },
    })

    await expect(waiter).resolves.toEqual({ id: 'cred' })
    const bag = await chrome.storage.session.get(passkeyBridgeResultStorageKey(ticket))
    expect(bag[passkeyBridgeResultStorageKey(ticket)]).toBeUndefined()
  })

  it('rejects when published failure result arrives via storage', async () => {
    const ticket = '00000000-0000-4000-8000-000000000001'
    const waiter = openPasskeyBridgeAndWait({
      mode: 'registration',
      optionsJSON: { challenge: 'xyz' },
      timeoutMs: 5_000,
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await publishPasskeyBridgeResult({
      ticket,
      ok: false,
      error: 'User cancelled.',
    })

    await expect(waiter).rejects.toThrow('User cancelled.')
  })
})
