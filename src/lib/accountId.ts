/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// NetSuite production and sandbox accounts always sit on a subdomain of
// `app.netsuite.com`. We deliberately reject `system.netsuite.com` and other
// non-account hosts because they cannot run SuiteQL through N/query.
//
// Hostname shapes we accept:
//   - Production:        `1234567.app.netsuite.com`
//   - TSTDRV sandbox:    `TSTDRV1234567.app.netsuite.com`
//   - Sandbox / RP:      `1234567-sb1.app.netsuite.com`, `1234567-rp.app.netsuite.com`
// The hyphen-suffix variants matter: each sandbox should cache separately from
// prod, so we capture the full subdomain (including `-sbN`) as the account id.
const ACCOUNT_HOST_REGEX = /^([a-zA-Z0-9-]+)\.app\.netsuite\.com$/i;

export function parseAccountId(hostname: string): string | null {
  const match = ACCOUNT_HOST_REGEX.exec(hostname);
  if (!match) {
    return null;
  }
  // Capture group 1 is guaranteed by the regex shape above.
  return match[1] ?? null;
}
