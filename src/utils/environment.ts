// ---------------------------------------------------------------------------
// Environment detection utilities
// ---------------------------------------------------------------------------

/**
 * Determine whether a NetSuite account ID refers to a Sandbox / Test environment.
 *
 * Sandbox account IDs contain `_SB` or `-SB` (e.g. `5848789_SB1`, `9260916-sb1`).
 * Test-drive accounts start with `TSTDRV`.
 */
export function isSandboxAccount(accountId: string): boolean {
  const upper = accountId.toUpperCase();
  return upper.includes('_SB') || upper.includes('-SB') || upper.startsWith('TSTDRV');
}

/**
 * Build the environment suffix that is appended to every tool description
 * during tool discovery (`list_tools`).
 *
 * Example output: ` [Account: 5848789_SB1, Env: Sandbox]`
 */
export function buildEnvSuffix(accountId: string | null): string {
  if (!accountId) return '';
  const isSandbox = isSandboxAccount(accountId);
  return ` [Account: ${accountId}, Env: ${isSandbox ? 'Sandbox' : 'Production'}]`;
}
