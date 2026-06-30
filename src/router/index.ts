import type { ModelRouteConfig, ProxyConfig, ResolvedRoute } from '../types/index.js';

/**
 * Router — resolves a model alias to its provider + upstream model name.
 *
 * If the alias is not found, falls back to passthrough mode: use the alias
 * as the model name with a default provider (if configured).
 */
export class Router {
  private modelMap = new Map<string, ModelRouteConfig>();
  private providerSet: Set<string>;

  constructor(config: ProxyConfig) {
    for (const model of config.models) {
      this.modelMap.set(model.alias, model);
    }
    this.providerSet = new Set(config.providers.map((p) => p.id));
  }

  /**
   * Resolve a model alias to its provider + upstream model.
   * @throws if the alias is not configured.
   */
  resolve(modelAlias: string): ResolvedRoute {
    const route = this.modelMap.get(modelAlias);
    if (!route) {
      throw new RouteError(
        `Model "${modelAlias}" not found`,
      );
    }

    if (!this.providerSet.has(route.providerId)) {
      throw new RouteError(
        `Provider "${route.providerId}" not found for model "${modelAlias}"`,
      );
    }

    return { provider: null!, modelRoute: route };
  }

  /** List all available model aliases. */
  listModels(): string[] {
    return Array.from(this.modelMap.keys());
  }

  /** Get all model routes. */
  getRoutes(): ModelRouteConfig[] {
    return Array.from(this.modelMap.values());
  }
}

/** Attach providers to the router for resolution. */
export class RouterWithProviders {
  private modelMap = new Map<string, ModelRouteConfig>();
  private providerMap = new Map<string, ProxyConfig['providers'][number]>();

  constructor(config: ProxyConfig) {
    for (const model of config.models) {
      this.modelMap.set(model.alias, model);
    }
    for (const provider of config.providers) {
      this.providerMap.set(provider.id, provider);
    }
  }

  resolve(modelAlias: string): ResolvedRoute {
    const route = this.modelMap.get(modelAlias);
    if (!route) {
      throw new RouteError(
        `Model "${modelAlias}" not found`,
      );
    }

    const provider = this.providerMap.get(route.providerId);
    if (!provider) {
      throw new RouteError(
        `Provider "${route.providerId}" not found for model "${modelAlias}"`,
      );
    }

    return { provider, modelRoute: route };
  }

  listModels(): string[] {
    return Array.from(this.modelMap.keys());
  }

  getRoutes(): ModelRouteConfig[] {
    return Array.from(this.modelMap.values());
  }
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteError';
  }
}
