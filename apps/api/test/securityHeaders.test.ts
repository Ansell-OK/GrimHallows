import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { TEST_ORACLE_KEY, stubChain, testOracleSigner } from './helpers/oracle.js';

describe('API security controls', () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('sets baseline response security headers', async () => {
    app = await buildServer({
      chain: stubChain(),
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: 'security-test-secret',
      logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('rejects oversized JSON bodies before route handling', async () => {
    app = await buildServer({
      chain: stubChain(),
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: 'security-test-secret',
      logger: false,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: 'x', signature: 'x', challenge: 'x'.repeat(300_000) },
    });
    expect(response.statusCode).toBe(413);
  });
});
