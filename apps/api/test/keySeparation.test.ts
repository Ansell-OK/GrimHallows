import { describe, expect, it } from 'vitest';
import { assertHostedApiKeySeparation } from '../src/config.js';

describe('hosted API key separation', () => {
  it('allows the oracle key but rejects owner/deployer private keys', () => {
    expect(() => assertHostedApiKeySeparation({ ORACLE_PRIVATE_KEY: 'oracle' })).not.toThrow();
    expect(() => assertHostedApiKeySeparation({ OWNER_PRIVATE_KEY: 'owner-secret' })).toThrow(/OWNER_PRIVATE_KEY/);
    expect(() => assertHostedApiKeySeparation({ DEPLOYER_PRIVATE_KEY: 'deployer-secret' })).toThrow(/DEPLOYER_PRIVATE_KEY/);
  });

  it('names variables without exposing their values', () => {
    const secret = 'must-not-appear';
    try {
      assertHostedApiKeySeparation({ OWNER_PRIVATE_KEY: secret });
      throw new Error('expected guard to throw');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
