/**
 * Whether the database connection gets TLS.
 *
 * Worth testing rather than eyeballing because both failure directions are bad
 * and neither is loud: TLS off against Supabase means the connection simply does
 * not work, and TLS accidentally on against local docker Postgres breaks the dev
 * loop with an error that reads like a credentials problem. The host detection
 * is a regex, which is exactly the kind of thing that works for every URL you
 * thought of.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sslConfig } from '../src/db.js';

const SUPABASE = 'postgresql://postgres.abcd:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres';
const LOCAL = 'postgresql://grimhallow:pw@localhost:5432/grimhallow';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sslConfig', () => {
  it('enables TLS for a remote host', () => {
    expect(sslConfig(SUPABASE)).toEqual({ rejectUnauthorized: false });
  });

  it('leaves TLS off for local Postgres, which has no certificate', () => {
    expect(sslConfig(LOCAL)).toBeUndefined();
    expect(sslConfig('postgresql://u:p@127.0.0.1:5432/db')).toBeUndefined();
    expect(sslConfig('postgresql://u:p@[::1]:5432/db')).toBeUndefined();
  });

  it('verifies the server when a CA is supplied', () => {
    vi.stubEnv('DATABASE_SSL_CA', '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
    expect(sslConfig(SUPABASE)).toEqual({
      ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
      rejectUnauthorized: true,
    });
  });

  it('requires authenticated TLS for a remote database on Vercel', () => {
    vi.stubEnv('VERCEL', '1');
    expect(() => sslConfig(SUPABASE)).toThrow(/DATABASE_SSL_CA/);

    vi.stubEnv('DATABASE_SSL_CA', 'production-ca');
    expect(sslConfig(SUPABASE)).toEqual({ ca: 'production-ca', rejectUnauthorized: true });
  });

  it('can be forced on for a local host and off for a remote one', () => {
    vi.stubEnv('DATABASE_SSL', 'true');
    expect(sslConfig(LOCAL)).toEqual({ rejectUnauthorized: false });

    vi.stubEnv('DATABASE_SSL', 'false');
    expect(sslConfig(SUPABASE)).toBeUndefined();
  });

  it('does not mistake a database or user named "localhost" for a local host', () => {
    // The host is what decides this, not any other part of the URL — matching
    // too loosely would silently drop TLS on a real remote connection.
    expect(sslConfig('postgresql://localhost:pw@db.example.com:5432/localhost')).toEqual({
      rejectUnauthorized: false,
    });
  });
});
