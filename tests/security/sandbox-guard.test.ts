import { describe, it, expect, beforeEach } from 'vitest';
import { resetConfig } from '../../src/core/config.js';
import { enforceSandboxGuardrails } from '../../src/executor/sandbox-guard.js';

describe('enforceSandboxGuardrails path canonicalization', () => {
  beforeEach(() => {
    process.env['HOME'] = '/home/testuser';
    resetConfig();
  });

  it.each([
    '~/.ssh',
    '~/.ssh/',
    '$HOME/.ssh',
    '${HOME}/.ssh',
    '~/.ssh/../.ssh',
    '$HOME//.ssh',
    '~/.ssh/./authorized_keys',
    '/home/testuser/.ssh',
    '/home/testuser/../testuser/.ssh',
  ])('blocks bypass form %s', (path) => {
    expect(() => enforceSandboxGuardrails({ path })).toThrow(/Blocked file path/);
  });

  it.each([
    '/tmp/output.txt',
    'relative/path/file.txt',
    'the ssh protocol is secure',
  ])('allows benign value %s', (path) => {
    expect(() => enforceSandboxGuardrails({ path })).not.toThrow();
  });
});
