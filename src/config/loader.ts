import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ProxyConfig } from '../types/index.js';

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  format: z.enum(['openai', 'anthropic']),
  apiVersion: z.string().optional(),
  timeout: z.number().int().positive().default(30000),
  headers: z.record(z.string()).optional(),
  supportsResponses: z.boolean().default(false),
});

const modelRouteSchema = z.object({
  alias: z.string().min(1),
  providerId: z.string().min(1),
  upstreamModel: z.string().min(1),
  maxConcurrent: z.number().int().positive().optional(),
  headers: z.record(z.string()).optional(),
});

const tokenSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1),
  maxConcurrent: z.number().int().positive().optional(),
  allowedModels: z.array(z.string().min(1)).optional(),
});

export const proxyConfigSchema = z.object({
  port: z.number().int().min(0).default(3000),
  authKey: z.string().optional(),
  globalMaxConcurrent: z.number().int().positive().default(10),
  providers: z.array(providerSchema).min(1),
  models: z.array(modelRouteSchema).min(1),
  tokens: z.array(tokenSchema).optional(),
});

/**
 * Load and validate proxy configuration from a JSON file.
 * Environment variables in the form ${VAR} are expanded.
 */
export function loadConfig(path: string): ProxyConfig {
  const raw = readFileSync(resolve(path), 'utf-8');
  const expanded = expandEnvVars(raw);
  const parsed = JSON.parse(expanded) as unknown;
  return proxyConfigSchema.parse(parsed) as ProxyConfig;
}

/** Replace ${VAR} patterns with process.env[VAR] or empty string. */
function expandEnvVars(input: string): string {
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? '';
  });
}
