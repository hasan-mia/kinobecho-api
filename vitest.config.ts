import { defineConfig } from 'vitest/config';
import unpluginSwc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    unpluginSwc.vite({
      jsc: {
        parser: {
          syntax: 'typescript',
          decorators: true,
          dynamicImport: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testEnvironment: 'node',
    globals: true,
    hookTimeout: 60000,
    teardownTimeout: 60000,
  },
});
