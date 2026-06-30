import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config/loader.js';

describe('config loader', () => {
  it('loads and validates a valid config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      port: 8080,
      globalMaxConcurrent: 5,
      providers: [{
        id: 'test-provider',
        name: 'Test',
        baseUrl: 'https://api.test.com',
        apiKey: 'sk-test',
        format: 'openai',
      }],
      models: [{
        alias: 'test-model',
        providerId: 'test-provider',
        upstreamModel: 'gpt-test',
      }],
    }));

    const config = loadConfig(configPath);
    expect(config.port).toBe(8080);
    expect(config.globalMaxConcurrent).toBe(5);
    expect(config.providers).toHaveLength(1);
    expect(config.models).toHaveLength(1);
  });

  it('applies default values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      providers: [{
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://api.test.com',
        apiKey: 'key',
        format: 'openai',
      }],
      models: [{
        alias: 'm1',
        providerId: 'p1',
        upstreamModel: 'model-1',
      }],
    }));

    const config = loadConfig(configPath);
    expect(config.port).toBe(3000);
    expect(config.globalMaxConcurrent).toBe(10);
    expect(config.providers[0].timeout).toBe(30000);
  });

  it('expands environment variables', () => {
    process.env.TEST_API_KEY = 'expanded-key-123';

    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      port: 3000,
      globalMaxConcurrent: 10,
      providers: [{
        id: 'p1',
        name: 'P1',
        baseUrl: 'https://api.test.com',
        apiKey: '${TEST_API_KEY}',
        format: 'openai',
      }],
      models: [{
        alias: 'm1',
        providerId: 'p1',
        upstreamModel: 'model-1',
      }],
    }));

    const config = loadConfig(configPath);
    expect(config.providers[0].apiKey).toBe('expanded-key-123');
  });

  it('rejects config with missing provider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      port: 3000,
      globalMaxConcurrent: 10,
      providers: [],
      models: [],
    }));

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects config with invalid port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      port: -1,
      globalMaxConcurrent: 10,
      providers: [{
        id: 'p1', name: 'P1', baseUrl: 'https://api.test.com', apiKey: 'k', format: 'openai',
      }],
      models: [{
        alias: 'm1', providerId: 'p1', upstreamModel: 'model-1',
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow();
  });
});
