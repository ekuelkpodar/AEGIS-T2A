/**
 * Sandbox Guardrails
 */

import { getConfig } from '../core/config.js';

export interface GuardViolation {
  type: 'egress' | 'filesystem';
  message: string;
  value: string;
}

const DEFAULT_BLOCKED_PATHS = [
  '~/.zshrc',
  '~/.bashrc',
  '~/.profile',
  '~/.gitconfig',
  '~/.ssh',
  '~/.local/bin',
  '.cursorrules',
  'CLAUDE.md',
];

export function enforceSandboxGuardrails(params: Record<string, unknown>): void {
  const config = getConfig();
  const blockedPaths = config.sandboxBlockedPaths.length > 0
    ? config.sandboxBlockedPaths
    : DEFAULT_BLOCKED_PATHS;

  const strings = extractStrings(params);
  for (const value of strings) {
    const violation = checkFilesystem(value, blockedPaths);
    if (violation) {
      throw new Error(violation.message);
    }

    const egressViolation = checkEgress(
      value,
      config.sandboxEnforceEgressAllowlist,
      config.sandboxAllowLocalhost,
      config.sandboxAllowedDomains
    );
    if (egressViolation) {
      throw new Error(egressViolation.message);
    }
  }
}

function checkFilesystem(value: string, blockedPaths: string[]): GuardViolation | null {
  const normalized = value.replace(/\\/g, '/');
  for (const blocked of blockedPaths) {
    const blockNorm = blocked.replace(/\\/g, '/');
    if (normalized.includes(blockNorm) || normalized.startsWith(blockNorm)) {
      return {
        type: 'filesystem',
        message: `Blocked file path access: ${value}`,
        value,
      };
    }
  }
  return null;
}

function checkEgress(
  value: string,
  enforce: boolean,
  allowLocalhost: boolean,
  allowlist: string[]
): GuardViolation | null {
  if (!enforce) return null;
  if (!value.startsWith('http://') && !value.startsWith('https://')) return null;

  let hostname = '';
  try {
    hostname = new URL(value).hostname;
  } catch {
    return null;
  }

  if (allowLocalhost && (hostname === 'localhost' || hostname === '127.0.0.1')) {
    return null;
  }

  if (allowlist.length === 0) {
    return {
      type: 'egress',
      message: `Egress blocked (no allowlist configured): ${hostname}`,
      value,
    };
  }

  const allowed = allowlist.some((entry) => matchesDomain(hostname, entry));
  if (!allowed) {
    return {
      type: 'egress',
      message: `Egress blocked to domain: ${hostname}`,
      value,
    };
  }
  return null;
}

function matchesDomain(hostname: string, entry: string): boolean {
  const normalized = entry.trim().toLowerCase();
  const target = hostname.toLowerCase();
  if (normalized.startsWith('*.')) {
    const base = normalized.slice(2);
    return target === base || target.endsWith(`.${base}`);
  }
  return target === normalized;
}

function extractStrings(value: unknown, depth: number = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => extractStrings(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((v) => extractStrings(v, depth + 1));
  }
  return [];
}
