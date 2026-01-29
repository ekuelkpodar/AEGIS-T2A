import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, './src/core'),
      '@gateway': path.resolve(__dirname, './src/gateway'),
      '@planner': path.resolve(__dirname, './src/planner'),
      '@simulation': path.resolve(__dirname, './src/simulation'),
      '@workflow': path.resolve(__dirname, './src/workflow'),
      '@provisioner': path.resolve(__dirname, './src/provisioner'),
      '@executor': path.resolve(__dirname, './src/executor'),
      '@registry': path.resolve(__dirname, './src/registry'),
      '@audit': path.resolve(__dirname, './src/audit'),
      '@secrets': path.resolve(__dirname, './src/secrets'),
      '@api': path.resolve(__dirname, './src/api'),
    },
  },
});
