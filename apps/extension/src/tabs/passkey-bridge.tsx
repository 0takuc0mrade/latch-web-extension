import '../style.css'

import { useCallback, useEffect, useState } from 'react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

import {
  formatWebauthnBrowserError,
  prepareAuthenticationOptionsForGet,
  prepareRegistrationOptionsForCreate,
} from '../ui/webauthn/passkey'
import {
  passkeyBridgeStorageKey,
  publishPasskeyBridgeResult,
  type PasskeyBridgeStoredPayload,
} from '../ui/webauthn/passkeyBridge'

export default function PasskeyBridgeTab() {
  const [status, setStatus] = useState('Loading passkey…')
  const [payload, setPayload] = useState<PasskeyBridgeStoredPayload | null>(null)
  const [ticket, setTicket] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, '')
    const nextTicket = raw ? decodeURIComponent(raw) : ''
    if (!nextTicket) {
      setStatus('Missing session. Close this window and try again from Latch.')
      return
    }
    setTicket(nextTicket)

    void (async () => {
      const key = passkeyBridgeStorageKey(nextTicket)
      const bag = await chrome.storage.session.get(key)
      const stored = bag[key] as PasskeyBridgeStoredPayload | undefined
      if (!stored) {
        setStatus('This passkey session expired. Close the window and try again.')
        return
      }
      await chrome.storage.session.remove(key)
      setPayload(stored)
      setStatus(
        stored.mode === 'registration'
          ? 'Create your Latch passkey'
          : 'Unlock with your Latch passkey'
      )
    })()
  }, [])

  const runCeremony = useCallback(() => {
    if (!payload || !ticket || busy) return
    setBusy(true)
    setStatus('Complete the passkey prompt from your system…')

    void (async () => {
      try {
        let response: unknown
        if (payload.mode === 'registration') {
          response = await startRegistration({
            optionsJSON: prepareRegistrationOptionsForCreate(payload.optionsJSON),
          } as Parameters<typeof startRegistration>[0])
        } else {
          response = await startAuthentication({
            optionsJSON: prepareAuthenticationOptionsForGet(payload.optionsJSON),
          } as Parameters<typeof startAuthentication>[0])
        }
        await publishPasskeyBridgeResult({ ticket, ok: true, response })
        window.close()
      } catch (e) {
        const msg = formatWebauthnBrowserError(e)
        await publishPasskeyBridgeResult({ ticket, ok: false, error: msg })
        window.close()
      }
    })()
  }, [busy, payload, ticket])

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg px-5 py-6 text-fg">
      <p className="text-center text-sm font-bold text-muted">{status}</p>
      {payload && ticket ? (
        <button
          type="button"
          disabled={busy}
          onClick={runCeremony}
          className="mt-6 h-11 w-full max-w-xs rounded-full bg-primary text-sm font-extrabold text-black shadow-soft disabled:opacity-50"
        >
          {busy ? 'Waiting…' : 'Continue'}
        </button>
      ) : null}
    </div>
  )
}
