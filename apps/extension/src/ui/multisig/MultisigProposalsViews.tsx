import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { MultisigProposal, MultisigProposalDetail, StoredAccount } from '@latch/types'

import { friendlyError, sendToBackground } from '../lib/backgroundClient'
import { formatMultisigProposalError } from '../lib/multisigErrors'
import {
  approveMultisigProposal,
  peekMultisigApprovalSigner,
  proposalNeedsMyApproval,
} from '../lib/multisigApprove'
import {
  clearPendingWalletOutcome,
  consumePendingWalletOutcomeIf,
  writePendingWalletOutcome,
} from '../../lib/walletOutcome'
import { apiGetProposal } from '../lib/multisigFlow'
import { MultisigProposalDetailScreen } from '../screens/multisig/MultisigProposalDetailScreen'
import { MultisigProposalsScreen } from '../screens/multisig/MultisigProposalsScreen'
import { LatchLoadingOverlay } from '../components/LatchLoadingOverlay'

export function MultisigProposalsViews({
  route,
  surface,
  activeAccount,
  accounts,
  externalProposalId,
  onSetRoute,
}: {
  route: string
  surface: 'popup' | 'sidepanel'
  activeAccount: StoredAccount | undefined
  accounts: StoredAccount[]
  externalProposalId?: string | null
  onSetRoute: (route: string) => void
}) {
  const [proposals, setProposals] = useState<MultisigProposal[]>([])
  const [proposalsLoading, setProposalsLoading] = useState(false)
  const [proposalsError, setProposalsError] = useState<string | null>(null)
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null)
  const [activeProposal, setActiveProposal] = useState<MultisigProposalDetail | null>(null)
  const [proposalBusy, setProposalBusy] = useState(false)
  const [proposalActionError, setProposalActionError] = useState<string | null>(null)

  const loadProposals = useCallback(async () => {
    if (!activeAccount?.smartAccountAddress || activeAccount.mode !== 'multisig') return
    setProposalsLoading(true)
    setProposalsError(null)
    try {
      const res = await sendToBackground<
        { smartAccountAddress: string },
        import('@latch/types').ListMultisigProposalsResponse
      >({
        type: 'MULTISIG_LIST_PROPOSALS',
        payload: { smartAccountAddress: activeAccount.smartAccountAddress },
      })
      if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
      setProposals(res.data.proposals ?? [])
    } catch (e) {
      setProposalsError(e instanceof Error ? e.message : String(e))
    } finally {
      setProposalsLoading(false)
    }
  }, [activeAccount])

  const loadProposalDetail = useCallback(async (id: string) => {
    setProposalBusy(true)
    try {
      const detail = await apiGetProposal(id)
      setActiveProposal(detail)
      setActiveProposalId(id)
    } finally {
      setProposalBusy(false)
    }
  }, [])

  useEffect(() => {
    if (route === 'multisigProposals' || route === 'multisigProposalDetail') {
      void loadProposals()
    }
  }, [route, loadProposals, activeAccount?.id])

  useEffect(() => {
    if (route !== 'multisigProposalDetail' || !externalProposalId) return
    setProposalActionError(null)
    void loadProposalDetail(externalProposalId)
  }, [route, externalProposalId, loadProposalDetail])

  useEffect(() => {
    void (async () => {
      const outcome = await consumePendingWalletOutcomeIf('multisigApprove')
      if (!outcome || outcome.status === 'in_progress') return
      const proposalId = outcome.payload?.proposalId
      if (typeof proposalId === 'string' && proposalId) {
        setActiveProposalId(proposalId)
        onSetRoute('multisigProposalDetail')
        void loadProposalDetail(proposalId)
      }
      setProposalBusy(false)
      if (outcome.status === 'failure') {
        setProposalActionError(formatMultisigProposalError(outcome.error ?? 'Approve failed.'))
      }
    })()
  }, [loadProposalDetail, onSetRoute])

  async function runApprove() {
    if (!activeProposal || !activeAccount) return

    setProposalBusy(true)
    setProposalActionError(null)
    try {
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'multisigApprove',
          status: 'in_progress',
          payload: { proposalId: activeProposal.id },
        })
      }
      const updated = await approveMultisigProposal({
        proposal: activeProposal,
        activeAccount,
        accounts,
        surface,
      })
      setActiveProposal(updated)
      await clearPendingWalletOutcome()
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setProposalActionError(formatMultisigProposalError(raw))
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'multisigApprove',
          status: 'failure',
          error: raw,
          payload: { proposalId: activeProposal.id },
        }).catch(() => {})
      }
    } finally {
      setProposalBusy(false)
      void loadProposals()
    }
  }

  const pendingApprovalCount = useMemo(() => {
    if (!activeAccount?.multisigMemberId) return 0
    return proposals.filter(
      (p) =>
        p.status !== 'executed' &&
        !(p as MultisigProposalDetail).approvals?.some(
          (a) => a.memberId === activeAccount.multisigMemberId
        )
    ).length
  }, [proposals, activeAccount?.multisigMemberId])

  const proposalApprovalUi = useMemo(() => {
    if (!activeProposal || !activeAccount) return null
    return peekMultisigApprovalSigner({
      proposal: activeProposal,
      activeAccount,
      accounts,
    })
  }, [activeProposal, activeAccount, accounts])

  if (route === 'multisigProposals') {
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col">
        <MultisigProposalsScreen
          proposals={proposals}
          loading={proposalsLoading}
          error={proposalsError}
          pendingCount={pendingApprovalCount}
          onBack={() => onSetRoute('home')}
          onOpenProposal={(id) => {
            void loadProposalDetail(id)
            onSetRoute('multisigProposalDetail')
          }}
        />
        {proposalsLoading ? <LatchLoadingOverlay label="Loading..." /> : null}
      </div>
    )
  }

  if (route === 'multisigProposalDetail') {
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col">
        <MultisigProposalDetailScreen
          proposal={activeProposal}
          loading={proposalBusy && !activeProposal}
          error={proposalActionError}
          busy={proposalBusy}
          needsMyApproval={
            activeProposal && activeAccount
              ? proposalNeedsMyApproval(activeProposal, activeAccount.multisigMemberId)
              : false
          }
          approveLabel={proposalApprovalUi?.approveLabel}
          approveBusyLabel={proposalApprovalUi?.busyLabel}
          onBack={() => onSetRoute('multisigProposals')}
          onApprove={() => {
            void runApprove()
          }}
          onExecute={() => {
            if (!activeProposalId) return
            setProposalBusy(true)
            setProposalActionError(null)
            void sendToBackground({
              type: 'MULTISIG_EXECUTE_PROPOSAL',
              payload: { proposalId: activeProposalId },
            })
              .then((res) => {
                if (!res.ok) {
                  setProposalActionError(formatMultisigProposalError(friendlyError(res.error)))
                  return
                }
                return loadProposalDetail(activeProposalId)
              })
              .catch((e) => {
                const raw = e instanceof Error ? e.message : String(e)
                setProposalActionError(formatMultisigProposalError(raw))
              })
              .finally(() => {
                setProposalBusy(false)
                void loadProposals()
              })
          }}
          onRefresh={() => {
            if (!activeProposalId) return
            setProposalBusy(true)
            setProposalActionError(null)
            void sendToBackground<{ proposalId: string }, MultisigProposalDetail>({
              type: 'MULTISIG_REFRESH_PROPOSAL',
              payload: { proposalId: activeProposalId },
            })
              .then((res) => {
                if (!res.ok) {
                  setProposalActionError(formatMultisigProposalError(friendlyError(res.error)))
                  return
                }
                if (res.data) setActiveProposal(res.data)
              })
              .catch((e) => {
                const raw = e instanceof Error ? e.message : String(e)
                setProposalActionError(formatMultisigProposalError(raw))
              })
              .finally(() => setProposalBusy(false))
          }}
        />
        {proposalBusy && !activeProposal ? <LatchLoadingOverlay label="Loading..." /> : null}
      </div>
    )
  }

  return null
}
