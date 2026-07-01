import { describe, it, expect } from '@jest/globals';
import { validateEnv } from './envValidator.js';

describe('Environment Validator', () => {
  it('should pass with empty or minimum environment variables', () => {
    const config = validateEnv({});
    expect(config.OAUTH_CALLBACK_PORT).toBe(8080);
    expect(config.PORT).toBeUndefined();
  });

  it('should validate and parse correct ports', () => {
    const config = validateEnv({
      PORT: '3000',
      OAUTH_CALLBACK_PORT: '9000',
      NETSUITE_ACCOUNT_ID: '123456_SB1'
    });
    expect(config.PORT).toBe(3000);
    expect(config.OAUTH_CALLBACK_PORT).toBe(9000);
    expect(config.NETSUITE_ACCOUNT_ID).toBe('123456_SB1');
  });

  it('should throw validation error on invalid ports', () => {
    expect(() => validateEnv({ PORT: 'invalid' })).toThrow('Environment validation failed');
    expect(() => validateEnv({ PORT: '99999' })).toThrow('Environment validation failed');
    expect(() => validateEnv({ OAUTH_CALLBACK_PORT: '-5' })).toThrow('Environment validation failed');
  });
});
