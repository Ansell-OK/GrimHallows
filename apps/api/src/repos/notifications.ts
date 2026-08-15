import { randomUUID } from 'node:crypto';
import { query } from '../db.js';

export interface NotificationRecord { readonly id: string; readonly address: string; readonly type: string; readonly payload: Record<string, unknown>; readonly read: boolean; readonly createdAt: Date; }
export interface NotificationStore {
  create(address: string, type: string, payload?: Record<string, unknown>): Promise<NotificationRecord>;
  list(address: string, limit: number): Promise<NotificationRecord[]>;
  unreadCount(address: string): Promise<number>;
  markRead(address: string, id: string): Promise<boolean>;
  markAllRead(address: string): Promise<number>;
}

interface Row { id: string; address: string; type: string; payload_json: Record<string, unknown>; read: boolean; created_at: Date; }
const fromRow = (r: Row): NotificationRecord => ({ id: r.id, address: r.address, type: r.type, payload: r.payload_json, read: r.read, createdAt: r.created_at });

export class PostgresNotificationStore implements NotificationStore {
  async create(address: string, type: string, payload: Record<string, unknown> = {}) { const { rows } = await query<Row>(`insert into notifications (id,address,type,payload_json) values ($1,$2,$3,$4) returning *`, [randomUUID(), address, type, payload]); return fromRow(rows[0]); }
  async list(address: string, limit: number) { const { rows } = await query<Row>(`select * from notifications where address=$1 order by created_at desc limit $2`, [address, limit]); return rows.map(fromRow); }
  async unreadCount(address: string) { const { rows } = await query<{ count: string }>(`select count(*)::text as count from notifications where address=$1 and not read`, [address]); return Number(rows[0]?.count ?? 0); }
  async markRead(address: string, id: string) { const result = await query(`update notifications set read=true where id=$1 and address=$2`, [id, address]); return (result.rowCount ?? 0) > 0; }
  async markAllRead(address: string) { const result = await query(`update notifications set read=true where address=$1 and not read`, [address]); return result.rowCount ?? 0; }
}

export class MemoryNotificationStore implements NotificationStore {
  private readonly rows: NotificationRecord[] = [];
  async create(address: string, type: string, payload: Record<string, unknown> = {}) { const row = { id: randomUUID(), address, type, payload, read: false, createdAt: new Date() }; this.rows.push(row); return row; }
  async list(address: string, limit: number) { return this.rows.filter((r) => r.address === address).sort((a,b) => b.createdAt.getTime()-a.createdAt.getTime()).slice(0, limit); }
  async unreadCount(address: string) { return this.rows.filter((r) => r.address === address && !r.read).length; }
  async markRead(address: string, id: string) { const index = this.rows.findIndex((r) => r.id === id && r.address === address); if (index < 0) return false; this.rows[index] = { ...this.rows[index], read: true }; return true; }
  async markAllRead(address: string) { let count=0; for(let i=0;i<this.rows.length;i++){ if(this.rows[i].address===address&&!this.rows[i].read){this.rows[i]={...this.rows[i],read:true};count++;}} return count; }
}
