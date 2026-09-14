import type { MultisigProposalDetail, StoredAccount } from '@latch/types'

import {
  assertPasskeyAssertionMatchesAuthDigest,
  buildPasskeySigDataXdrFromAssertion,
  passkeyAuthenticationOptionsForAuthDigest,
} from '../../ui/webauthn/passkey'
import { multisigProposalApproveWebauthn } from '../api/multisigProposals'
import { getAccounts } from '../storage'
import { runPasskeyBridgeAndWait } from '../webauthn/passkeyBridge'

function findPasskeySigningAccount(args: {
  activeAccount: StoredAccount
  accounts: StoredAccount[]
  memberCredentialId?: string
}): StoredAccount | undefined {
  const { activeAccount, accounts, memberCredentialId } = args

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

export async function executeMultisigPasskeyApproveInBackground(args: {
  accountId: string
  proposalId: string
  memberId: string
  authDigestHex: string
  memberCredentialId?: string
}): Promise<MultisigProposalDetail> {
  const { accounts } = await getAccounts()
  const activeAccount = accounts.find((a) => a.id === args.accountId)
  if (!activeAccount) throw new Error('No active account')

  const authDigestHex = args.authDigestHex.trim()
  if (!authDigestHex) throw new Error('Proposal is missing auth digest.')
  if (!args.memberId.trim()) throw new Error('Missing multisig member id for this account.')
  if (!args.proposalId.trim()) throw new Error('Missing proposal id.')

  const passkeyAccount = findPasskeySigningAccount({
    activeAccount,
    accounts,
    memberCredentialId: args.memberCredentialId,
  })
  const credentialId = passkeyAccount?.passkeyCredentialId?.trim()
  if (!credentialId) {
    throw new Error('No passkey is available to approve this proposal.')
  }

  const optionsJSON = passkeyAuthenticationOptionsForAuthDigest({
    authDigestHex,
    credentialId,
  })

  const assertion = await runPasskeyBridgeAndWait({
    mode: 'authentication',
    optionsJSON,
  })
  assertPasskeyAssertionMatchesAuthDigest(assertion, authDigestHex)
  const sigDataXdrHex = buildPasskeySigDataXdrFromAssertion(assertion)

  return await multisigProposalApproveWebauthn({
    proposalId: args.proposalId,
    memberId: args.memberId,
    sigDataXdrHex,
  })
}
