import type {
  MultisigAccountMember,
  MultisigApproveDelegatedFinishRequest,
  MultisigProposalDetail,
  SignDelegatedGAuthEntryRequest,
  SignDelegatedGAuthEntryResponse,
  StoredAccount,
} from '@latch/types'

import { fetchActiveNetwork, networkPassphraseFor } from './activeNetwork'
import { friendlyError, sendToBackground } from './backgroundClient'

export type MultisigApprovalSignerKind = 'passkey' | 'delegated'

export function findProposalMember(
  proposal: MultisigProposalDetail,
  memberId: string | undefined
): MultisigAccountMember | undefined {
  const id = memberId?.trim()
  if (!id) return undefined
  return proposal.members?.find((m) => m.id === id)
}

export function isMultisigDelegatedMember(member: MultisigAccountMember | undefined): boolean {
  if (!member) return false
  const memberType = (member.memberType ?? member.type ?? '').trim().toLowerCase()
  if (memberType === 'seed' || memberType === 'delegated') return true
  if (member.gAddress?.trim()) return true
  return false
}

export function isMultisigPasskeyMember(member: MultisigAccountMember | undefined): boolean {
  if (!member || isMultisigDelegatedMember(member)) return false
  const memberType = (member.memberType ?? member.type ?? '').trim().toLowerCase()
  return (
    memberType === 'passkey' || memberType === 'webauthn' || Boolean(member.credentialId?.trim())
  )
}

export function findDelegatedSigningAccount(
  accounts: StoredAccount[],
  gAddress?: string
): StoredAccount | undefined {
  const expected = gAddress?.trim()
  return accounts.find((account) => {
    if (account.mode !== 'mnemonic') return false
    const g = account.gAddress?.trim()
    if (!g) return false
    return !expected || g === expected
  })
}

export function resolveMultisigMemberId(
  proposal: MultisigProposalDetail,
  activeAccount: StoredAccount
): string | undefined {
  return activeAccount.multisigMemberId?.trim() || proposal.memberId?.trim()
}

export function resolveMultisigApprovalSigner(args: {
  proposal: MultisigProposalDetail
  activeAccount: StoredAccount
  accounts: StoredAccount[]
}): {
  kind: MultisigApprovalSignerKind
  memberId: string
  member?: MultisigAccountMember
  signingAccount?: StoredAccount
} {
  const memberId = resolveMultisigMemberId(args.proposal, args.activeAccount)
  if (!memberId) throw new Error('Missing multisig member id for this account.')

  const member = findProposalMember(args.proposal, memberId)
  if (member && isMultisigDelegatedMember(member)) {
    const signingAccount = findDelegatedSigningAccount(args.accounts, member.gAddress)
    if (!signingAccount) {
      const g = member.gAddress?.trim()
      throw new Error(
        g
          ? `No local wallet found for ${g}. Import or connect the G-address used for this multisig owner.`
          : 'No delegated G-address wallet is available to approve this proposal.'
      )
    }
    return { kind: 'delegated', memberId, member, signingAccount }
  }

  if (member && !isMultisigPasskeyMember(member)) {
    throw new Error('Could not determine how to sign for this multisig member.')
  }

  return { kind: 'passkey', memberId, member }
}

export function peekMultisigApprovalSigner(args: {
  proposal: MultisigProposalDetail
  activeAccount: StoredAccount
  accounts: StoredAccount[]
}): {
  kind: MultisigApprovalSignerKind
  approveLabel: string
  busyLabel: string
} | null {
  try {
    const resolved = resolveMultisigApprovalSigner(args)
    return {
      kind: resolved.kind,
      approveLabel: multisigApprovalButtonLabel(resolved.kind),
      busyLabel: multisigApprovalBusyLabel(resolved.kind),
    }
  } catch {
    return null
  }
}

export function multisigApprovalButtonLabel(kind: MultisigApprovalSignerKind): string {
  if (kind === 'delegated') {
    return 'Approve with wallet'
  }
  return 'Approve with passkey'
}

export function multisigApprovalBusyLabel(kind: MultisigApprovalSignerKind): string {
  return kind === 'delegated' ? 'Signing…' : 'Signing…'
}

function parseDelegatedBeginTemplate(data: Record<string, unknown>): {
  templateXdr: string
  signerAddress?: string
} {
  const nested = data.delegatedCheckAuthTemplate
  if (nested && typeof nested === 'object') {
    const record = nested as Record<string, unknown>
    const templateXdr =
      readNonEmptyString(record.entryTemplateXdrBase64) ??
      readNonEmptyString(record.entryTemplateXdr) ??
      readNonEmptyString(record.gAddressEntryTemplateXdr)
    if (templateXdr) {
      return {
        templateXdr,
        signerAddress: readNonEmptyString(data.signerAddress),
      }
    }
  }

  const templateXdr =
    readNonEmptyString(data.entryTemplateXdrBase64) ??
    readNonEmptyString(data.gAddressEntryTemplateXdr) ??
    readNonEmptyString(data.entryTemplateXdr)
  if (templateXdr) {
    return {
      templateXdr,
      signerAddress: readNonEmptyString(data.signerAddress),
    }
  }

  throw new Error('Delegated approval is missing auth entry template from server.')
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function findPasskeySigningAccount(args: {
  activeAccount: StoredAccount
  accounts: StoredAccount[]
  member?: MultisigAccountMember
}): StoredAccount | undefined {
  const { activeAccount, accounts, member } = args
  const memberCredentialId = member?.credentialId?.trim()

  if (memberCredentialId) {
    const byMember = accounts.find(
      (account) =>
        account.mode === 'passkey' && account.passkeyCredentialId?.trim() === memberCredentialId
    )
    if (byMember) return byMember
  }

  if (activeAccount.mode === 'passkey' && activeAccount.passkeyCredentialId?.trim()) {
    return activeAccount
  }

  return (
    accounts.find(
      (account) =>
        account.mode === 'passkey' &&
        account.passkeyCredentialId?.trim() &&
        (account.id === activeAccount.id ||
          account.smartAccountAddress === activeAccount.smartAccountAddress ||
          Boolean(account.passkeyKeyDataHex?.trim()))
    ) ??
    accounts.find((account) => account.mode === 'passkey' && account.passkeyCredentialId?.trim())
  )
}

export async function approveMultisigProposalWithPasskey(args: {
  proposal: MultisigProposalDetail
  activeAccount: StoredAccount
  accounts: StoredAccount[]
  surface: 'popup' | 'sidepanel'
  memberId?: string
  member?: MultisigAccountMember
}): Promise<MultisigProposalDetail> {
  const { proposal, activeAccount, accounts, surface } = args
  const authDigestHex = proposal.authDigestHex?.trim()
  const memberId = args.memberId ?? resolveMultisigMemberId(proposal, activeAccount)
  const member = args.member ?? findProposalMember(proposal, memberId)
  if (!authDigestHex) throw new Error('Proposal is missing auth digest.')
  if (!memberId) throw new Error('Missing multisig member id for this account.')
  if (!proposal.id) throw new Error('Missing proposal id.')

  const passkeyAccount = findPasskeySigningAccount({
    activeAccount,
    accounts,
    member,
  })
  const credentialId = passkeyAccount?.passkeyCredentialId?.trim()
  if (!credentialId) {
    throw new Error('No passkey is available to approve this proposal.')
  }

  const assertion = await runPasskeyBridgeViaBackground({
    proposalId: proposal.id,
    memberId,
    authDigestHex,
    accountId: activeAccount.id,
    memberCredentialId: member?.credentialId,
    surface,
  })
  return assertion
}

async function runPasskeyBridgeViaBackground(args: {
  proposalId: string
  memberId: string
  authDigestHex: string
  accountId: string
  memberCredentialId?: string
  surface: 'popup' | 'sidepanel'
}): Promise<MultisigProposalDetail> {
  const res = await sendToBackground<
    {
      accountId: string
      proposalId: string
      memberId: string
      authDigestHex: string
      memberCredentialId?: string
      surface: 'popup' | 'sidepanel'
      outcomePayload?: Record<string, unknown>
    },
    MultisigProposalDetail
  >({
    type: 'EXECUTE_MULTISIG_PASSKEY_APPROVE',
    payload: {
      accountId: args.accountId,
      proposalId: args.proposalId,
      memberId: args.memberId,
      authDigestHex: args.authDigestHex,
      memberCredentialId: args.memberCredentialId,
      surface: args.surface,
      outcomePayload: { proposalId: args.proposalId },
    },
  })
  if (!res.ok) throw new Error(friendlyError(res.error))
  return res.data!
}

export async function approveMultisigProposalWithDelegated(args: {
  proposal: MultisigProposalDetail
  activeAccount: StoredAccount
  accounts: StoredAccount[]
  memberId?: string
  member?: MultisigAccountMember
  signingAccount?: StoredAccount
}): Promise<MultisigProposalDetail> {
  const { proposal, activeAccount, accounts } = args
  const memberId = args.memberId ?? resolveMultisigMemberId(proposal, activeAccount)
  const member = args.member ?? findProposalMember(proposal, memberId)
  if (!memberId) throw new Error('Missing multisig member id for this account.')
  if (!proposal.id) throw new Error('Missing proposal id.')

  const signingAccount =
    args.signingAccount ?? findDelegatedSigningAccount(accounts, member?.gAddress)
  if (!signingAccount) {
    const g = member?.gAddress?.trim()
    throw new Error(
      g
        ? `No local wallet found for ${g}. Import or connect the G-address used for this multisig owner.`
        : 'No delegated G-address wallet is available to approve this proposal.'
    )
  }

  const beginRes = await sendToBackground<
    { proposalId: string; memberId: string },
    Record<string, unknown>
  >({
    type: 'MULTISIG_APPROVE_DELEGATED_BEGIN',
    payload: { proposalId: proposal.id, memberId },
  })
  if (!beginRes.ok || !beginRes.data) throw new Error(friendlyError(beginRes.error))

  const { templateXdr } = parseDelegatedBeginTemplate(beginRes.data)
  const networkPassphrase = networkPassphraseFor((await fetchActiveNetwork()).network)

  const signRes = await sendToBackground<
    SignDelegatedGAuthEntryRequest,
    SignDelegatedGAuthEntryResponse
  >({
    type: 'SIGN_DELEGATED_G_AUTH_ENTRY',
    payload: {
      accountId: signingAccount.id,
      gAddressEntryTemplateXdr: templateXdr,
      networkPassphrase,
    },
  })
  if (!signRes.ok || !signRes.data) throw new Error(friendlyError(signRes.error))
  const signedAuthEntryBase64 = signRes.data.signedAuthEntryBase64
  const signerAddress = signRes.data.signerAddress

  const finishRes = await sendToBackground<
    MultisigApproveDelegatedFinishRequest,
    MultisigProposalDetail
  >({
    type: 'MULTISIG_APPROVE_DELEGATED_FINISH',
    payload: {
      proposalId: proposal.id,
      memberId,
      signedAuthEntryBase64,
      signerAddress,
    },
  })
  if (!finishRes.ok) throw new Error(friendlyError(finishRes.error))
  return finishRes.data!
}

export async function approveMultisigProposal(args: {
  proposal: MultisigProposalDetail
  activeAccount: StoredAccount
  accounts: StoredAccount[]
  surface: 'popup' | 'sidepanel'
}): Promise<MultisigProposalDetail> {
  const resolved = resolveMultisigApprovalSigner(args)
  if (resolved.kind === 'delegated') {
    return approveMultisigProposalWithDelegated({
      ...args,
      memberId: resolved.memberId,
      member: resolved.member,
      signingAccount: resolved.signingAccount,
    })
  }
  return approveMultisigProposalWithPasskey({
    ...args,
    memberId: resolved.memberId,
    member: resolved.member,
  })
}

export function proposalNeedsMyApproval(
  proposal: MultisigProposalDetail,
  memberId: string | undefined
): boolean {
  if (!memberId || proposal.status === 'executed') return false
  const approvals = proposal.approvals ?? []
  return !approvals.some((a) => a.memberId === memberId)
}

export function proposalReadyToExecute(proposal: MultisigProposalDetail): boolean {
  const threshold = proposal.threshold ?? 0
  const count = proposal.approvalCount ?? proposal.approvals?.length ?? 0
  const status = proposal.status
  if (status === 'executed' || status === 'submitted' || status === 'cancelled') return false
  return count >= threshold
}
