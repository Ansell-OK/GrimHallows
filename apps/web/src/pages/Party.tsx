import React, { useCallback, useEffect, useState } from 'react';
import { TopBar } from '@/components/layout/TopBar';
import { Button } from '@/components/ui/Button';
import { useWallet } from '@/lib/wallet';
import { createParty, createPartyInvite, errorMessage, getCurrentParty, getPartyInvites, leaveParty, respondPartyInvite, setPartyReady, type PartyInvite, type PartyRecord } from '@/lib/api';

const shortAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

export default function Party() {
  const { address, status } = useWallet();
  const [party, setParty] = useState<PartyRecord | null>(null);
  const [invites, setInvites] = useState<PartyInvite[]>([]);
  const [invitee, setInvitee] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!address) { setParty(null); setInvites([]); return; }
    try { const [current, pending] = await Promise.all([getCurrentParty(), getPartyInvites()]); setParty(current.party); setInvites(pending.invites); setError(null); }
    catch (err) { setError(errorMessage(err)); }
  }, [address]);
  useEffect(() => { void load(); }, [load]);
  const act = async (work: () => Promise<unknown>) => { setBusy(true); try { await work(); await load(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  if (status !== 'connected' || !address) return <div className="min-h-screen bg-obsidian"><TopBar /><main className="pt-32 px-6 text-center text-gray-400 font-ui">Connect a wallet to manage your party.</main></div>;
  const self = party?.members.find((member) => member.address === address);
  const leader = self?.role === 'leader';
  return <div className="min-h-screen bg-obsidian"><TopBar /><main className="pt-28 px-6 pb-12 max-w-6xl mx-auto">
    <div className="flex flex-wrap items-end justify-between gap-4 mb-8"><div><p className="text-xs font-ui tracking-widest uppercase text-gray-500">Party</p><h1 className="text-3xl font-display text-gray-100">{party ? 'Your Expedition' : 'Find An Expedition'}</h1></div>{party ? <div className="text-right font-ui text-xs text-gray-400"><div>{party.members.length}/4 members</div><div>{party.members.filter((member) => member.ready).length}/{party.members.length} ready</div></div> : null}</div>
    {error ? <div className="mb-5 border border-blood/50 bg-blood/10 p-3 text-sm text-gray-200">{error}</div> : null}
    {invites.length ? <section className="mb-8 border border-stone p-5"><h2 className="font-display text-lg text-gray-200 mb-4">Pending Invites</h2><div className="space-y-3">{invites.map((invite) => <div className="flex flex-wrap gap-3 items-center justify-between" key={invite.id}><span className="font-ui text-sm text-gray-300">From {shortAddress(invite.inviterAddress)}</span><span className="flex gap-2"><Button size="sm" variant="stx" disabled={busy} onClick={() => act(() => respondPartyInvite(invite.id, true))}>Accept</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => respondPartyInvite(invite.id, false))}>Decline</Button></span></div>)}</div></section> : null}
    {!party ? <section className="border border-stone p-8 text-center"><p className="font-ui text-gray-400 mb-5">Create a party to invite up to three other players.</p><Button variant="stx" disabled={busy} onClick={() => act(createParty)}>Create Party</Button></section> : <div className="grid lg:grid-cols-[1fr_320px] gap-8"><section className="border border-stone p-6"><div className="flex justify-between gap-4 mb-5"><h2 className="font-display text-xl text-gray-200">Roster</h2><span className="font-ui text-xs text-gray-500">Code: {party.inviteCode}</span></div><div className="grid sm:grid-cols-2 gap-3">{party.members.map((member) => <div key={member.address} className="border border-stone bg-obsidian/50 p-4"><div className="flex justify-between gap-3"><span className="font-ui text-sm text-gray-200">{shortAddress(member.address)}</span><span className={member.ready ? 'text-rot text-xs font-ui' : 'text-gray-500 text-xs font-ui'}>{member.ready ? 'READY' : 'NOT READY'}</span></div><p className="mt-3 text-xs font-ui text-gray-500">{member.nftTokenId ? `Character #${member.nftTokenId}` : 'Character not selected'}</p>{member.address === address ? <Button className="mt-4 w-full" size="sm" variant={member.ready ? 'secondary' : 'stx'} disabled={busy || !member.nftTokenId} onClick={() => act(() => setPartyReady(party.id, !member.ready))}>{member.ready ? 'Unready' : 'Ready'}</Button> : null}</div>)}</div></section><aside className="border border-stone p-6 h-fit"><h2 className="font-display text-lg text-gray-200 mb-4">Actions</h2>{leader ? <form className="space-y-3 mb-5" onSubmit={(event) => { event.preventDefault(); if (invitee.trim()) void act(() => createPartyInvite(party.id, invitee.trim())); }}><input value={invitee} onChange={(event) => setInvitee(event.target.value)} placeholder="Stacks address" className="w-full bg-obsidian border border-stone p-3 text-sm text-gray-200" /><Button className="w-full" size="sm" variant="secondary" disabled={busy || !invitee.trim()}>Invite Player</Button></form> : null}<Button className="w-full" size="sm" variant="danger" disabled={busy} onClick={() => act(() => leaveParty(party.id))}>{leader ? 'Disband Party' : 'Leave Party'}</Button><p className="mt-5 text-xs font-ui leading-relaxed text-gray-500">Party dungeon entry is not enabled yet. Nothing on this screen charges your wallet.</p></aside></div>}
  </main></div>;
}
