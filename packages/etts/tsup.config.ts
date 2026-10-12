import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  treeshake: true,
});
