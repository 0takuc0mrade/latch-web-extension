/**
 * @deprecated Full-app durable handoff was removed. Outcome restore lives in
 * `../../lib/walletOutcome` + background confirm jobs.
 */

export {
  clearPendingWalletOutcome as clearDurableHandoffFlag,
  isWalletResultOnlyUi as isDurableWalletUi,
  readPendingWalletOutcome as readPendingWebauthnFlow,
  type PendingWalletOutcome as PendingWebauthnFlow,
} from '../../lib/walletOutcome'

export async function isDurableHandoffActive(): Promise<boolean> {
  return false
}

export async function ensureDurableWalletUi(_args: unknown): Promise<{ relocated: false }> {
  return { relocated: false }
}

export async function consumePendingWebauthnFlowIf(_kind: string): Promise<null> {
  return null
}
