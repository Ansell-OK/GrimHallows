import { randomBytes, randomUUID } from 'node:crypto';
import { query } from '../db.js';

export type PartyRole = 'leader' | 'member';

export interface PartyMember {
  readonly address: string;
  readonly role: PartyRole;
  readonly ready: boolean;
  readonly nftContractId: string | null;
  readonly nftTokenId: string | null;
  readonly joinedAt: Date;
}

export interface PartyRecord {
  readonly id: string;
  readonly inviteCode: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly members: readonly PartyMember[];
}

export type CreatePartyResult =
  | { readonly kind: 'created'; readonly party: PartyRecord }
  | { readonly kind: 'already_member'; readonly party: PartyRecord };
export type LeavePartyResult = 'left' | 'disbanded' | 'not_member';
export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'expired';
export interface PartyInvite { readonly id: string; readonly partyId: string; readonly inviterAddress: string; readonly inviteeAddress: string; readonly status: InviteStatus; readonly createdAt: Date; readonly expiresAt: Date; readonly respondedAt: Date | null; }
export type CreateInviteResult = { readonly kind: 'created' | 'existing'; readonly invite: PartyInvite } | { readonly kind: 'not_leader' | 'already_member' | 'self' | 'party_full' };
export type RespondInviteResult = 'accepted' | 'declined' | 'not_found' | 'expired' | 'party_full' | 'already_member';

export interface PartyStore {
  create(address: string): Promise<CreatePartyResult>;
  current(address: string): Promise<PartyRecord | null>;
  leave(partyId: string, address: string): Promise<LeavePartyResult>;
  invite(partyId: string, inviter: string, invitee: string): Promise<CreateInviteResult>;
  pendingInvites(address: string): Promise<PartyInvite[]>;
  respondToInvite(inviteId: string, address: string, accept: boolean): Promise<RespondInviteResult>;
}

interface InviteRow { id: string; party_id: string; inviter_address: string; invitee_address: string; status: InviteStatus; created_at: Date; expires_at: Date; responded_at: Date | null; }
const fromInviteRow = (row: InviteRow): PartyInvite => ({ id: row.id, partyId: row.party_id, inviterAddress: row.inviter_address, inviteeAddress: row.invitee_address, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at, respondedAt: row.responded_at });

interface PartyRow {
  id: string;
  invite_code: string;
  created_by: string;
  created_at: Date;
  address: string;
  role: PartyRole;
  ready: boolean;
  nft_contract_id: string | null;
  nft_token_id: string | null;
  joined_at: Date;
}

function fromRows(rows: PartyRow[]): PartyRecord | null {
  const first = rows[0];
  if (!first) return null;
  return {
    id: first.id,
    inviteCode: first.invite_code,
    createdBy: first.created_by,
    createdAt: first.created_at,
    members: rows.map((row) => ({
      address: row.address,
      role: row.role,
      ready: row.ready,
      nftContractId: row.nft_contract_id,
      nftTokenId: row.nft_token_id,
      joinedAt: row.joined_at,
    })),
  };
}

const selectParty = `
  select p.*, pm.address, pm.role, pm.ready, pm.nft_contract_id,
         pm.nft_token_id::text, pm.joined_at
  from parties p
  join party_members owner on owner.party_id = p.id
  join party_members pm on pm.party_id = p.id
  where owner.address = $1
  order by pm.joined_at, pm.address`;

export class PostgresPartyStore implements PartyStore {
  async create(address: string): Promise<CreatePartyResult> {
    const id = randomUUID();
    const inviteCode = randomBytes(9).toString('base64url');
    const { rows } = await query<PartyRow>(`
      with locked as materialized (
        select pg_advisory_xact_lock(hashtextextended($1, 0))
      ), existing as (
        select party_id from party_members cross join locked where address = $1
      ), inserted_party as (
        insert into parties (id, invite_code, created_by)
        select $2, $3, $1 where not exists (select 1 from existing)
        returning id
      ), inserted_member as (
        insert into party_members (party_id, address, role)
        select id, $1, 'leader' from inserted_party
        returning party_id
      ), chosen as (
        select party_id from existing
        union all
        select party_id from inserted_member
      )
      select p.*, pm.address, pm.role, pm.ready, pm.nft_contract_id,
             pm.nft_token_id::text, pm.joined_at
      from chosen c
      join parties p on p.id = c.party_id
      join party_members pm on pm.party_id = p.id
      order by pm.joined_at, pm.address`, [address, id, inviteCode]);
    const party = fromRows(rows)!;
    return { kind: party.id === id ? 'created' : 'already_member', party };
  }

  async current(address: string): Promise<PartyRecord | null> {
    const { rows } = await query<PartyRow>(selectParty, [address]);
    return fromRows(rows);
  }

  async leave(partyId: string, address: string): Promise<LeavePartyResult> {
    const { rows } = await query<{ outcome: LeavePartyResult }>(`
      with membership as (
        select role from party_members where party_id = $1 and address = $2
      ), deleted_party as (
        delete from parties
        where id = $1 and exists (select 1 from membership where role = 'leader')
        returning id
      ), deleted_member as (
        delete from party_members
        where party_id = $1 and address = $2
          and exists (select 1 from membership where role = 'member')
        returning party_id
      )
      select case
        when exists (select 1 from deleted_party) then 'disbanded'
        when exists (select 1 from deleted_member) then 'left'
        else 'not_member'
      end as outcome`, [partyId, address]);
    return rows[0]?.outcome ?? 'not_member';
  }

  async invite(partyId: string, inviter: string, invitee: string): Promise<CreateInviteResult> {
    if (inviter === invitee) return { kind: 'self' };
    const id = randomUUID();
    const { rows } = await query<(InviteRow & { outcome: string })>(`
      with locked as materialized (
        select pg_advisory_xact_lock(hashtextextended($1, 0))
      ), facts as (
        select
          exists(select 1 from party_members cross join locked where party_id=$1 and address=$2 and role='leader') as leader,
          exists(select 1 from party_members where address=$3) as member,
          (select count(*) from party_members where party_id=$1) as size
      ), inserted as (
        insert into party_invites (id, party_id, inviter_address, invitee_address, expires_at)
        select $4, $1, $2, $3, now() + interval '7 days' from facts
        where leader and not member and size < 4
        on conflict (party_id, invitee_address) where status='pending' do nothing
        returning *
      ), chosen as (
        select *, 'created'::text as outcome from inserted
        union all
        select pi.*, 'existing'::text from party_invites pi, facts
        where pi.party_id=$1 and pi.invitee_address=$3 and pi.status='pending'
          and facts.leader and not facts.member and facts.size < 4
          and not exists(select 1 from inserted)
      ) select * from chosen`, [partyId, inviter, invitee, id]);
    if (rows[0]) return { kind: rows[0].outcome as 'created' | 'existing', invite: fromInviteRow(rows[0]) };
    const current = await this.current(inviter);
    if (!current || current.id !== partyId || current.members[0] === undefined || !current.members.some((m) => m.address === inviter && m.role === 'leader')) return { kind: 'not_leader' };
    if (await this.current(invitee)) return { kind: 'already_member' };
    return { kind: 'party_full' };
  }

  async pendingInvites(address: string): Promise<PartyInvite[]> {
    const { rows } = await query<InviteRow>(`update party_invites set status='expired' where invitee_address=$1 and status='pending' and expires_at <= now() returning *`, [address]);
    void rows;
    const result = await query<InviteRow>(`select * from party_invites where invitee_address=$1 and status='pending' order by created_at desc`, [address]);
    return result.rows.map(fromInviteRow);
  }

  async respondToInvite(inviteId: string, address: string, accept: boolean): Promise<RespondInviteResult> {
    const { rows } = await query<{ outcome: RespondInviteResult }>(`
      with target as materialized (
        select * from party_invites where id=$1 and invitee_address=$2 and status='pending'
      ), locked as materialized (
        select pg_advisory_xact_lock(hashtextextended(coalesce((select party_id::text from target), $1), 0)),
               pg_advisory_xact_lock(hashtextextended($2, 0))
      ), facts as (
        select t.*, exists(select 1 from party_members cross join locked where address=$2) as member,
               (select count(*) from party_members where party_id=t.party_id) as size
        from target t
      ), joined as (
        insert into party_members (party_id,address,role)
        select party_id,$2,'member' from facts where $3 and expires_at > now() and not member and size < 4
        returning party_id
      ), updated as (
        update party_invites pi set status=case when $3 then 'accepted' else 'declined' end,
          responded_at=now()
        from facts f where pi.id=f.id and f.expires_at > now()
          and (not $3 or exists(select 1 from joined)) returning pi.id
      ) select case
        when not exists(select 1 from target) then 'not_found'
        when (select expires_at <= now() from facts) then 'expired'
        when $3 and (select member from facts) then 'already_member'
        when $3 and (select size >= 4 from facts) then 'party_full'
        when $3 and exists(select 1 from updated) then 'accepted'
        when not $3 and exists(select 1 from updated) then 'declined'
        else 'not_found' end as outcome`, [inviteId, address, accept]);
    const outcome = rows[0]?.outcome ?? 'not_found';
    if (outcome === 'expired') await query(`update party_invites set status='expired', responded_at=now() where id=$1 and status='pending'`, [inviteId]);
    return outcome;
  }
}

export class MemoryPartyStore implements PartyStore {
  private readonly parties = new Map<string, PartyRecord>();
  private readonly invites = new Map<string, PartyInvite>();

  async create(address: string): Promise<CreatePartyResult> {
    const existing = await this.current(address);
    if (existing) return { kind: 'already_member', party: existing };
    const now = new Date();
    const party: PartyRecord = {
      id: randomUUID(),
      inviteCode: randomBytes(9).toString('base64url'),
      createdBy: address,
      createdAt: now,
      members: [{ address, role: 'leader', ready: false, nftContractId: null, nftTokenId: null, joinedAt: now }],
    };
    this.parties.set(party.id, party);
    return { kind: 'created', party };
  }

  async current(address: string): Promise<PartyRecord | null> {
    return [...this.parties.values()].find((party) => party.members.some((member) => member.address === address)) ?? null;
  }

  async leave(partyId: string, address: string): Promise<LeavePartyResult> {
    const party = this.parties.get(partyId);
    const member = party?.members.find((candidate) => candidate.address === address);
    if (!party || !member) return 'not_member';
    if (member.role === 'leader') { this.parties.delete(partyId); return 'disbanded'; }
    this.parties.set(partyId, { ...party, members: party.members.filter((candidate) => candidate.address !== address) });
    return 'left';
  }

  async invite(partyId: string, inviter: string, invitee: string): Promise<CreateInviteResult> {
    if (inviter === invitee) return { kind: 'self' };
    const party = this.parties.get(partyId);
    if (!party?.members.some((member) => member.address === inviter && member.role === 'leader')) return { kind: 'not_leader' };
    if (await this.current(invitee)) return { kind: 'already_member' };
    if (party.members.length >= 4) return { kind: 'party_full' };
    const existing = [...this.invites.values()].find((row) => row.partyId === partyId && row.inviteeAddress === invitee && row.status === 'pending');
    if (existing) return { kind: 'existing', invite: existing };
    const now = new Date();
    const invite: PartyInvite = { id: randomUUID(), partyId, inviterAddress: inviter, inviteeAddress: invitee, status: 'pending', createdAt: now, expiresAt: new Date(now.getTime() + 7 * 86400_000), respondedAt: null };
    this.invites.set(invite.id, invite);
    return { kind: 'created', invite };
  }

  async pendingInvites(address: string): Promise<PartyInvite[]> {
    const now = Date.now();
    for (const [id, invite] of this.invites) if (invite.status === 'pending' && invite.expiresAt.getTime() <= now) this.invites.set(id, { ...invite, status: 'expired' });
    return [...this.invites.values()].filter((invite) => invite.inviteeAddress === address && invite.status === 'pending').sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async respondToInvite(inviteId: string, address: string, accept: boolean): Promise<RespondInviteResult> {
    const invite = this.invites.get(inviteId);
    if (!invite || invite.inviteeAddress !== address || invite.status !== 'pending') return 'not_found';
    if (invite.expiresAt.getTime() <= Date.now()) { this.invites.set(inviteId, { ...invite, status: 'expired', respondedAt: new Date() }); return 'expired'; }
    if (accept) {
      if (await this.current(address)) return 'already_member';
      const party = this.parties.get(invite.partyId);
      if (!party) return 'not_found';
      if (party.members.length >= 4) return 'party_full';
      this.parties.set(party.id, { ...party, members: [...party.members, { address, role: 'member', ready: false, nftContractId: null, nftTokenId: null, joinedAt: new Date() }] });
    }
    this.invites.set(inviteId, { ...invite, status: accept ? 'accepted' : 'declined', respondedAt: new Date() });
    return accept ? 'accepted' : 'declined';
  }
}
