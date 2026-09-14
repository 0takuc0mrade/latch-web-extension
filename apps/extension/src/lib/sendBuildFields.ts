import type { BuildSendTxResponse } from '@latch/types'

/** Map Render build-send fields (`authEntriesXdr` + indices) onto legacy delegated field names. */
export function normalizeDelegatedBuildFields(build: BuildSendTxResponse): BuildSendTxResponse {
  const entries = build.authEntriesXdr
  if (!entries?.length) return build

  const next: BuildSendTxResponse = { ...build }

  const smartIdx = next.smartAccountAuthEntryIndex ?? 0
  if (!next.smartAccountAuthEntryXdr && entries[smartIdx]) {
    next.smartAccountAuthEntryXdr = entries[smartIdx]
  }

  if (!next.gAddressEntryTemplateXdr) {
    const delegatedIndices = next.delegatedNativeAuthEntryIndices
    if (delegatedIndices?.length) {
      const gIdx = delegatedIndices[0]!
      if (entries[gIdx]) next.gAddressEntryTemplateXdr = entries[gIdx]
    }
  }

  if (!next.authEntryXdr?.trim() && next.smartAccountAuthEntryXdr) {
    next.authEntryXdr = next.smartAccountAuthEntryXdr
  }

  return next
}

export function isDelegatedSendBuild(build: BuildSendTxResponse): build is BuildSendTxResponse & {
  gAddressEntryTemplateXdr: string
  smartAccountAuthEntryXdr: string
} {
  const b = normalizeDelegatedBuildFields(build)
  if (!b.gAddressEntryTemplateXdr || !b.smartAccountAuthEntryXdr) return false

  return (
    b.submitMethod === 'delegated' ||
    b.submitMethod === 'bundler-delegated' ||
    Boolean(b.gAddressPreimageXdr) ||
    (b.delegatedGAuthEntrySynthesized === true &&
      Boolean(b.delegatedNativeAuthEntryIndices?.length))
  )
}

/** Smart-account auth entry XDR to attach the passkey signature to on submit. */
export function resolvePasskeyAuthEntryXdr(build: BuildSendTxResponse): string {
  const normalized = normalizeDelegatedBuildFields(build)
  const entries = normalized.authEntriesXdr
  const idx = normalized.smartAccountAuthEntryIndex ?? 0
  if (entries?.length && entries[idx]) {
    return entries[idx]!
  }
  const xdr = normalized.authEntryXdr?.trim()
  if (!xdr) {
    throw new Error('Missing auth entry from transaction build.')
  }
  return xdr
}

/** Pass full auth entry list to submit when API built swap with bundler fee-payer. */
export function multiAuthSubmitFields(build: BuildSendTxResponse): {
  authEntriesXdr?: string[]
  smartAccountAuthEntryIndex?: number
  delegatedGAuthEntrySynthesized?: boolean
  delegatedNativeAuthEntryIndices?: number[]
} {
  if (!build.authEntriesXdr?.length) return {}
  return {
    authEntriesXdr: build.authEntriesXdr,
    smartAccountAuthEntryIndex: build.smartAccountAuthEntryIndex ?? 0,
    ...(build.delegatedGAuthEntrySynthesized === true
      ? { delegatedGAuthEntrySynthesized: true as const }
      : {}),
    ...(build.delegatedNativeAuthEntryIndices?.length
      ? { delegatedNativeAuthEntryIndices: build.delegatedNativeAuthEntryIndices }
      : {}),
  }
}

/** Extra submit-delegated fields for multi-auth swap/send (which G row the user signed). */
export function delegatedSubmitFields(
  build: BuildSendTxResponse,
  signedDelegatedEntryIndex: number
): {
  authEntriesXdr?: string[]
  smartAccountAuthEntryIndex?: number
  delegatedGAuthEntrySynthesized?: boolean
  delegatedNativeAuthEntryIndices?: number[]
  delegatedNativeAuthEntryIndex: number
} {
  return {
    ...multiAuthSubmitFields(build),
    delegatedNativeAuthEntryIndex: signedDelegatedEntryIndex,
  }
}

export function contextRuleIdForSubmit(build: BuildSendTxResponse): number {
  const id = build.contextRuleId
  if (typeof id === 'number' && Number.isFinite(id)) return id

  const ruleIds = build.contextRuleIds
  if (Array.isArray(ruleIds) && ruleIds.length > 0) {
    const first = ruleIds[0]
    if (typeof first === 'number' && Number.isFinite(first)) return first
  }

  const parsed = Number.parseInt(String(id ?? ''), 10)
  if (!Number.isFinite(parsed)) {
    throw new Error('Missing or invalid contextRuleId from transaction build.')
  }
  return parsed
}

/** @deprecated Prefer `contextRuleIdForSubmit` for API bodies — Render expects JSON integer. */
export function contextRuleIdString(build: BuildSendTxResponse): string {
  return String(contextRuleIdForSubmit(build))
}
