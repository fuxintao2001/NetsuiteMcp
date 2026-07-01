import { describe, it, expect } from '@jest/globals';
import { isSandboxAccount, formatNetSuiteAccountHost, buildEnvSuffix } from './environment.js';

describe('Environment Utilities', () => {
  describe('isSandboxAccount', () => {
    it('should correctly classify sandbox accounts containing _SB', () => {
      expect(isSandboxAccount('123456_SB1')).toBe(true);
      expect(isSandboxAccount('5848789_sb2')).toBe(true);
    });

    it('should correctly classify sandbox accounts containing -SB', () => {
      expect(isSandboxAccount('9260916-sb1')).toBe(true);
      expect(isSandboxAccount('9260916-SB3')).toBe(true);
    });

    it('should correctly classify test drive accounts starting with TSTDRV', () => {
      expect(isSandboxAccount('TSTDRV123456')).toBe(true);
      expect(isSandboxAccount('tstdrv_789')).toBe(true);
    });

    it('should correctly classify production accounts', () => {
      expect(isSandboxAccount('123456')).toBe(false);
      expect(isSandboxAccount('COMPANY_PROD')).toBe(false);
    });
  });

  describe('formatNetSuiteAccountHost', () => {
    it('should format account IDs to lowercase and replace underscores with hyphens', () => {
      expect(formatNetSuiteAccountHost('123456_SB1')).toBe('123456-sb1');
      expect(formatNetSuiteAccountHost(' 9260916_sb3 ')).toBe('9260916-sb3');
      expect(formatNetSuiteAccountHost('COMPANY_PROD')).toBe('company-prod');
    });
  });

  describe('buildEnvSuffix', () => {
    it('should return empty string if accountId is null', () => {
      expect(buildEnvSuffix(null)).toBe('');
    });

    it('should append suffix with Sandbox env if sandbox account ID', () => {
      expect(buildEnvSuffix('123456_SB1')).toBe(' [Account: 123456_SB1, Env: Sandbox]');
    });

    it('should append suffix with Production env if production account ID', () => {
      expect(buildEnvSuffix('123456')).toBe(' [Account: 123456, Env: Production]');
    });
  });
});
