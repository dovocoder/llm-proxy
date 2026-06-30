import { timingSafeEqual } from 'node:crypto';
import type { ApiTokenConfig, ProxyConfig } from '../types/index.js';

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if both strings are equal.
 */
function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * TokenManager — resolves API tokens from the `Authorization: Bearer <token>` header.
 *
 * Supports two auth modes:
 * 1. **Token-based** — `tokens` array in config, each with optional per-token
 *    concurrency limit and model allowlist.
 * 2. **Legacy authKey** — single `authKey` in config, grants access to all models
 *    with no per-token concurrency.
 *
 * If neither `tokens` nor `authKey` is configured, the proxy is open (no auth).
 *
 * All token comparisons use constant-time comparison to prevent timing attacks.
 */
export class TokenManager {
  private tokenEntries: Array<{ token: string; config: ApiTokenConfig }> = [];
  private legacyAuthKey: string | undefined;

  constructor(config: ProxyConfig) {
    this.legacyAuthKey = config.authKey;
    for (const token of config.tokens ?? []) {
      this.tokenEntries.push({ token: token.token, config: token });
    }
  }

  /** Whether any form of authentication is configured. */
  get authEnabled(): boolean {
    return this.legacyAuthKey !== undefined || this.tokenEntries.length > 0;
  }

  /**
   * Authenticate a bearer token using constant-time comparison.
   * Returns the matched ApiTokenConfig if the token is a named token,
   * or a synthetic "all access" config if it matches the legacy authKey.
   * Returns null if authentication fails.
   */
  authenticate(bearerToken: string): ApiTokenConfig | null {
    // Check named tokens with constant-time comparison.
    for (const entry of this.tokenEntries) {
      if (safeCompare(entry.token, bearerToken)) {
        return entry.config;
      }
    }

    // Fall back to legacy authKey (full access).
    if (this.legacyAuthKey !== undefined && safeCompare(this.legacyAuthKey, bearerToken)) {
      return { token: bearerToken, name: 'legacy-authKey' };
    }

    return null;
  }

  /** Check if a token is allowed to access a specific model alias. */
  canAccessModel(tokenConfig: ApiTokenConfig, modelAlias: string): boolean {
    if (!tokenConfig.allowedModels || tokenConfig.allowedModels.length === 0) {
      return true; // No restriction = all models.
    }
    return tokenConfig.allowedModels.includes(modelAlias);
  }

  /** List model aliases accessible by a token (filtered by allowedModels). */
  accessibleModels(tokenConfig: ApiTokenConfig, allModels: string[]): string[] {
    if (!tokenConfig.allowedModels || tokenConfig.allowedModels.length === 0) {
      return allModels;
    }
    return allModels.filter((m) => tokenConfig.allowedModels!.includes(m));
  }
}
