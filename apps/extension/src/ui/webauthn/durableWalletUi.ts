/**
 * Action popups are destroyed when they lose focus (e.g. hybrid/QR WebAuthn).
 * Before any ceremony from the ephemeral toolbar popup, promote to a durable
 * chrome.windows.create popup and resume the flow there.
 */

import type { Route, Surface } from '../routing/routes'
import type { SendDraft, SendStep } from '../types/send'
import type { SwapDraft, SwapQuoteVm } from '../swap/swapVm'

export const PENDING_WEBAUTHN_FLOW_KEY = 'latch.pendingWebauthnFlow' as const
/** Set while promoting action popup → durable window so pagehide does not reject dapp reviews. */
export const DURABLE_HANDOFF_FLAG_KEY = 'latch.durableHandoffActive' as const

/** Freshness window for handoff tickets. */
export const PENDING_WEBAUTHN_FLOW_TTL_MS = 5 * 60 * 1000

export type PendingWebauthnFlow =
  | {
      version: 1
      kind: 'swapConfirm'
      route: 'swapConfirm'
      autoResume: true
      createdAt: number
      draft: SwapDraft
      quote: SwapQuoteVm
    }
  | {
      version: 1
      kind: 'sendSubmit'
      route: 'send'
      autoResume: true
      createdAt: number
      draft: SendDraft
      sendStep: SendStep
      sendTokenPriceUsd: number | null
    }
  | {
      version: 1
      kind: 'dappApproval'
      route: 'dappApproval'
      autoResume: true
      createdAt: number
    }
  | {
      version: 1
      kind: 'multisigApprove'
      route: 'multisigProposalDetail'
      autoResume: true
      createdAt: number
      proposalId: string
    }
  | {
      version: 1
      kind: 'passkeyRegistration'
      route: Extract<Route, 'createPasskey' | 'addAccountPasskey'>
      autoResume: true
      createdAt: number
      optionsJSON: unknown
      displayName?: string
    }
  | {
      version: 1
      kind: 'passkeyAuthentication'
      route: Extract<Route, 'addAccountPasskey' | 'chooseSigner'>
      autoResume: true
      createdAt: number
      optionsJSON: unknown
    }

export function isDurableWalletUi(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('durable') === '1') return true
  } catch {
    // ignore
  }
  return /[?#&]durable=1(?:&|$)/.test(window.location.href)
}

export function isPendingWebauthnFlowFresh(
  pending: { createdAt?: number } | null | undefined,
  nowMs = Date.now(),
  ttlMs = PENDING_WEBAUTHN_FLOW_TTL_MS
): boolean {
  if (!pending || typeof pending.createdAt !== 'number') return false
  return nowMs - pending.createdAt <= ttlMs
}

/**
 * True when WebAuthn would run in the ephemeral browser-action popup that
 * Chrome/Brave destroy on focus loss. Side panel and chrome.windows.create
 * popups are durable.
 */
export async function isEphemeralActionPopup(surface: Surface): Promise<boolean> {
  if (surface !== 'popup') return false
  if (isDurableWalletUi()) return false

  try {
    if (typeof chrome !== 'undefined' && chrome.windows?.getCurrent) {
      const win = await chrome.windows.getCurrent()
      // windows.create({ type: 'popup' }) surfaces report type "popup".
      // The toolbar action popup is tied to a normal browser window.
      if (win?.type === 'popup') return false
    }
  } catch {
    // fall through
  }

  return true
}

export async function readPendingWebauthnFlow(): Promise<PendingWebauthnFlow | null> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return null
  const bag = await chrome.storage.session.get(PENDING_WEBAUTHN_FLOW_KEY)
  const raw = bag[PENDING_WEBAUTHN_FLOW_KEY] as PendingWebauthnFlow | undefined
  if (!raw || raw.version !== 1) return null
  if (!isPendingWebauthnFlowFresh(raw)) {
    await chrome.storage.session.remove(PENDING_WEBAUTHN_FLOW_KEY).catch(() => {})
    return null
  }
  return raw
}

/** Read and clear a fresh pending flow (or clear stale and return null). */
export async function consumePendingWebauthnFlow(): Promise<PendingWebauthnFlow | null> {
  const pending = await readPendingWebauthnFlow()
  if (!pending) return null
  await chrome.storage.session.remove(PENDING_WEBAUTHN_FLOW_KEY).catch(() => {})
  return pending
}

/** Consume only when the pending kind matches — avoids sibling route views stealing handoffs. */
export async function consumePendingWebauthnFlowIf<K extends PendingWebauthnFlow['kind']>(
  kind: K
): Promise<Extract<PendingWebauthnFlow, { kind: K }> | null> {
  const pending = await readPendingWebauthnFlow()
  if (!pending || pending.kind !== kind) return null
  await chrome.storage.session.remove(PENDING_WEBAUTHN_FLOW_KEY).catch(() => {})
  return pending as Extract<PendingWebauthnFlow, { kind: K }>
}

export async function writePendingWebauthnFlow(pending: PendingWebauthnFlow): Promise<void> {
  try {
    JSON.stringify(pending)
  } catch {
    throw new Error('Pending wallet flow is not serializable for durable handoff.')
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.session) {
    throw new Error('Durable wallet handoff requires chrome.storage.session.')
  }
  await chrome.storage.session.set({ [PENDING_WEBAUTHN_FLOW_KEY]: pending })
}

export type EnsureDurableWalletUiResult =
  | { relocated: false }
  | { relocated: true; windowId?: number }

/**
 * If the current UI is the ephemeral action popup, persist `pending` and open a
 * durable popup window. Caller must return immediately when `relocated` is true
 * so WebAuthn never starts in the dying document.
 */
export async function ensureDurableWalletUi(args: {
  surface: Surface
  pending: PendingWebauthnFlow
}): Promise<EnsureDurableWalletUiResult> {
  if (!(await isEphemeralActionPopup(args.surface))) {
    return { relocated: false }
  }

  if (typeof chrome === 'undefined' || !chrome.windows?.create) {
    throw new Error('Durable wallet window requires Chrome extension APIs.')
  }

  await writePendingWebauthnFlow(args.pending)
  await chrome.storage.session.set({ [DURABLE_HANDOFF_FLAG_KEY]: true })

  const url = chrome.runtime.getURL('popup.html?durable=1')

  return await new Promise((resolve, reject) => {
    chrome.windows.create(
      {
        url,
        type: 'popup',
        width: 360,
        height: 600,
        focused: true,
      },
      (win) => {
        const err = chrome.runtime.lastError
        if (err) {
          void chrome.storage.session
            .remove([PENDING_WEBAUTHN_FLOW_KEY, DURABLE_HANDOFF_FLAG_KEY])
            .catch(() => {})
          reject(new Error(err.message || 'Failed to open durable wallet window.'))
          return
        }
        resolve({ relocated: true, windowId: win?.id })
      }
    )
  })
}

/** Clear the handoff flag once the durable window has mounted. */
export async function clearDurableHandoffFlag(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return
  await chrome.storage.session.remove(DURABLE_HANDOFF_FLAG_KEY).catch(() => {})
}

export async function isDurableHandoffActive(): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return false
  const bag = await chrome.storage.session.get(DURABLE_HANDOFF_FLAG_KEY)
  return Boolean(bag[DURABLE_HANDOFF_FLAG_KEY])
}
