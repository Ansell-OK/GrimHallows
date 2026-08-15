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

export interface PartyStore {
  create(address: string): Promise<CreatePartyResult>;
  current(address: string): Promise<PartyRecord | null>;
  leave(partyId: string, address: string): Promise<LeavePartyResult>;
}

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
}

export class MemoryPartyStore implements PartyStore {
  private readonly parties = new Map<string, PartyRecord>();

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
}
