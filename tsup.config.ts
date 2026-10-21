import { defineConfig, type Options } from 'tsup'

const shared: Options = {
  format: ['esm', 'cjs'],
  dts: {
    // tsup sets baseUrl internally when generating declarations, which TypeScript 6 deprecates.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  sourcemap: true,
  target: 'es2020',
  outDir: 'dist',
  external: ['react', 'react-dom', '@paystack/inline-js'],
}

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    clean: true,
    // The client entry uses hooks, so React Server Components must treat it as a client module.
    banner: { js: "'use client';" },
  },
  {
    ...shared,
    entry: { server: 'src/server/index.ts' },
    clean: false,
  },
])
