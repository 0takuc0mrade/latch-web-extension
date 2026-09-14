import type { ExternalSignResult, PendingDappRequest, SignTransactionResponse } from '@latch/types'

import { BackendError } from '../api/client'
import type { ExternalSignDecision } from '../externalSign/orchestrator'
import { addPendingDappRequest, clearPendingDappRequests } from '../storage'

type PendingResolver = (result: ExternalSignDecision) => void
export const pendingDappResolvers = new Map<string, PendingResolver>()
const approvalPopupWindowIds = new Set<number>()

export function mergePermissions<T extends string>(base: T[], add: T): T[] {
  return base.includes(add) ? base : [...base, add]
}

export function waitForExternalSignDecision(requestId: string): Promise<ExternalSignDecision> {
  return new Promise((resolve) => {
    pendingDappResolvers.set(requestId, resolve)
  })
}

function rejectAllPendingDappRequests(decision: ExternalSignDecision = { approved: false }) {
  for (const [requestId, resolver] of pendingDappResolvers.entries()) {
    resolver(decision)
    pendingDappResolvers.delete(requestId)
  }
  void clearPendingDappRequests()
}

function rejectPendingOnWindowClose(windowId: number) {
  if (!approvalPopupWindowIds.has(windowId)) return
  approvalPopupWindowIds.delete(windowId)
  rejectAllPendingDappRequests({ approved: false })
}

export function initDappApprovalListeners() {
  if (chrome.windows?.onRemoved) {
    chrome.windows.onRemoved.addListener((windowId) => {
      rejectPendingOnWindowClose(windowId)
    })
  }
}

export async function openApprovalPopup(): Promise<number | undefined> {
  try {
    if ('action' in chrome && typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup()
      return undefined
    }
  } catch {
    // fall through to window.create
  }

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?durable=1'),
      type: 'popup',
      width: 400,
      height: 650,
    })
    if (win.id !== undefined) {
      approvalPopupWindowIds.add(win.id)
      return win.id
    }
  } catch (err) {
    console.error('[latch:background] openApprovalPopup failed', err)
  }
  return undefined
}

export async function requireDappApproval(args: {
  origin: string
  kind: PendingDappRequest['kind']
  signRequest?: PendingDappRequest['signRequest']
  prepared?: PendingDappRequest['prepared']
  source?: PendingDappRequest['source']
}): Promise<ExternalSignDecision> {
  const requestId = crypto.randomUUID()
  const pending: PendingDappRequest = {
    id: requestId,
    origin: args.origin,
    kind: args.kind,
    createdAt: Date.now(),
    signRequest: args.signRequest,
    prepared: args.prepared,
    source: args.source,
  }
  // Register waiter before durable enqueue so LIST cannot treat this as an orphan.
  const decisionPromise = waitForExternalSignDecision(requestId)
  await addPendingDappRequest(pending)
  await openApprovalPopup()
  return await decisionPromise
}

export function mapExternalSignResultToProviderResponse(
  result: ExternalSignResult
): SignTransactionResponse {
  if (result.status === 'rejected') {
    throw new BackendError(result.message ?? 'User rejected', {
      status: 403,
      code: result.code ?? 'user_rejected',
    })
  }
  if (result.status === 'error') {
    throw new BackendError(result.message ?? 'Signing failed', {
      status: 400,
      code: result.code ?? 'error',
    })
  }
  return {
    txHash: result.txHash,
    signedAuthEntry: result.signedAuthEntry,
    signedTxXdr: result.signedTxXdr,
    signedXdr: result.signedTxXdr ?? result.txHash,
  }
}
