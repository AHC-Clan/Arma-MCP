import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import { resolveMcpTokenFile } from '../config.js';

const MIN_TOKEN_BYTES = 32;

function validateToken(value: string, source: string): string {
  const token = value.trim();
  if (Buffer.byteLength(token, 'utf8') < MIN_TOKEN_BYTES) {
    throw new Error(
      `${source} must contain at least ${MIN_TOKEN_BYTES} bytes; use a 256-bit random bearer token`,
    );
  }
  return token;
}

function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.ARMA_MCP_TOKEN;
  return value ? validateToken(value, 'ARMA_MCP_TOKEN') : null;
}

/** Resolve a token without creating files. Used by relay and CLI processes. */
export function loadMcpToken(cfg: Config, env: NodeJS.ProcessEnv = process.env): string {
  const envToken = tokenFromEnv(env);
  if (envToken) return envToken;

  const tokenFile = resolveMcpTokenFile(cfg);
  if (!existsSync(tokenFile)) {
    throw new Error(
      `MCP daemon token not found at ${tokenFile}; start the daemon first or set ARMA_MCP_TOKEN`,
    );
  }
  return validateToken(readFileSync(tokenFile, 'utf8'), tokenFile);
}

/** Same lookup as loadMcpToken, but null instead of throwing. */
export function tryLoadMcpToken(cfg: Config): string | null {
  try {
    return loadMcpToken(cfg);
  } catch {
    return null;
  }
}

/**
 * Resolve the daemon token, atomically generating its default file if absent.
 * The token value is deliberately never logged or returned in diagnostics.
 */
export function ensureMcpToken(cfg: Config): string {
  const envToken = tokenFromEnv();
  if (envToken) return envToken;

  const tokenFile = resolveMcpTokenFile(cfg);
  if (existsSync(tokenFile)) {
    return validateToken(readFileSync(tokenFile, 'utf8'), tokenFile);
  }

  mkdirSync(path.dirname(tokenFile), { recursive: true });
  const generated = randomBytes(32).toString('base64url');
  let fd: number | null = null;
  try {
    fd = openSync(tokenFile, 'wx', 0o600);
    writeFileSync(fd, generated + '\n', { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }

  return validateToken(readFileSync(tokenFile, 'utf8'), tokenFile);
}
