// ---------------------------------------------------------------------------
// Environment utility tests
// ---------------------------------------------------------------------------

import { isSandboxAccount, buildEnvSuffix } from './environment.js';

describe('isSandboxAccount', () => {
  it('returns true for _SB suffix', () => {
    expect(isSandboxAccount('5848789_SB1')).toBe(true);
    expect(isSandboxAccount('5848789_sb2')).toBe(true);
  });

  it('returns true for -SB suffix', () => {
    expect(isSandboxAccount('9260916-sb1')).toBe(true);
    expect(isSandboxAccount('9260916-SB3')).toBe(true);
  });

  it('returns true for TSTDRV prefix', () => {
    expect(isSandboxAccount('TSTDRV1234567')).toBe(true);
    expect(isSandboxAccount('tstdrv9999')).toBe(true);
  });

  it('returns false for production accounts', () => {
    expect(isSandboxAccount('5848789')).toBe(false);
    expect(isSandboxAccount('9260916')).toBe(false);
  });

  it('returns false for accounts containing SB elsewhere', () => {
    expect(isSandboxAccount('SB123456')).toBe(false);
  });
});

describe('buildEnvSuffix', () => {
  it('returns empty string for null', () => {
    expect(buildEnvSuffix(null)).toBe('');
  });

  it('returns Sandbox suffix for sandbox account', () => {
    expect(buildEnvSuffix('5848789_SB1')).toBe(' [Account: 5848789_SB1, Env: Sandbox]');
  });

  it('returns Production suffix for production account', () => {
    expect(buildEnvSuffix('5848789')).toBe(' [Account: 5848789, Env: Production]');
  });
});
