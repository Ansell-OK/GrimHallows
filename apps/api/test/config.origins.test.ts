/**
 * WEB_ORIGIN parsing.
 *
 * This is the CORS allowlist, so the interesting cases are the ones where a
 * sloppy value would quietly widen it rather than fail: a trailing comma that
 * becomes an empty origin, or a trailing slash that makes a correct origin miss.
 * Both look fine in a dashboard env-var field.
 */

import { describe, expect, it } from 'vitest';
import { parseOriginList } from '../src/config.js';

describe('parseOriginList', () => {
  it('returns a single origin unchanged', () => {
    expect(parseOriginList('https://grimhallow.vercel.app')).toEqual([
      'https://grimhallow.vercel.app',
    ]);
  });

  it('splits a comma-separated list so production and a preview can coexist', () => {
    expect(
      parseOriginList('https://grimhallow.vercel.app,https://grimhallow-git-dev.vercel.app'),
    ).toEqual(['https://grimhallow.vercel.app', 'https://grimhallow-git-dev.vercel.app']);
  });

  it('tolerates whitespace around entries', () => {
    expect(parseOriginList(' https://a.example , https://b.example ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('drops a trailing comma instead of allowing an empty origin', () => {
    // An "" entry in the allowlist is not merely useless: @fastify/cors compares
    // the Origin header by equality, and a stray empty string is the kind of
    // thing that invites a later "why is this here" fix in the wrong direction.
    expect(parseOriginList('https://a.example,')).toEqual(['https://a.example']);
  });

  it('strips a trailing slash, which never matches an Origin header', () => {
    // Browsers send `Origin: https://a.example` with no path, so a value copied
    // out of the address bar as `https://a.example/` would match nothing and
    // fail every request with a CORS error that names no cause.
    expect(parseOriginList('https://a.example/')).toEqual(['https://a.example']);
  });

  it('keeps the port, which is part of the origin', () => {
    expect(parseOriginList('http://localhost:3000')).toEqual(['http://localhost:3000']);
  });

  it('refuses a value that contains no origins at all', () => {
    expect(() => parseOriginList(' , , ')).toThrow(/no origins/);
  });
});
