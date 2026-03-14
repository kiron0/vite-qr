import { defineConfig, type Options } from 'tsup';

const commonOptions: Pick<
  Options,
  'minify' | 'platform' | 'target' | 'treeshake' | 'esbuildOptions'
> = {
  minify: 'terser',
  platform: 'node',
  target: 'node18',
  treeshake: true,
  esbuildOptions(options) {
    options.drop = ['debugger'];
  },
};

export default defineConfig([
  {
    ...commonOptions,
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: false,
    external: ['vite'],
    noExternal: ['uqr'],
  },
  {
    ...commonOptions,
    entry: {
      require: 'src/require.cts',
      'cli/index': 'src/cli/index.ts',
    },
    format: ['cjs'],
    dts: false,
    clean: false,
    sourcemap: false,
    external: ['vite', 'commander', '@clack/prompts', 'typescript'],
    noExternal: ['uqr'],
  },
]);
