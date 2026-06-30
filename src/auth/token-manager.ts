import type { ApiTokenConfig, ProxyConfig } from '../types/index.js';

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
 */
export class TokenManager {
  private tokenMap = new Map<string, ApiTokenConfig>();
  private legacyAuthKey: string | undefined;

  constructor(config: ProxyConfig) {
    this.legacyAuthKey = config.authKey;
    for (const token of config.tokens ?? []) {
      this.tokenMap.set(token.token, token);
    }
  }

  /** Whether any form of authentication is configured. */
  get authEnabled(): boolean {
    return this.legacyAuthKey !== undefined || this.tokenMap.size > 0;
  }

  /**
   * Authenticate a bearer token.
   * Returns the matched ApiTokenConfig if the token is a named token,
   * or a synthetic "all access" config if it matches the legacy authKey.
   * Returns null if authentication fails.
   */
  authenticate(bearerToken: string): ApiTokenConfig | null {
    // Check named tokens first.
    const tokenConfig = this.tokenMap.get(bearerToken);
    if (tokenConfig) return tokenConfig;

    // Fall back to legacy authKey (full access).
    if (this.legacyAuthKey !== undefined && bearerToken === this.legacyAuthKey) {
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
