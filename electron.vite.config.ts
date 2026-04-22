import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'
import type { UserConfig as ViteUserConfig } from 'vite'

type OptimizeDepsPlugin = NonNullable<NonNullable<NonNullable<ViteUserConfig['optimizeDeps']>['esbuildOptions']>['plugins']>[number]

const nodeGlobalsPolyfillPlugin = NodeGlobalsPolyfillPlugin({
  process: true,
  buffer: true
}) as unknown as OptimizeDepsPlugin

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({exclude: ['node-carplay']})]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        stream: "stream-browserify",
        Buffer: "buffer",
      }
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          global: 'globalThis'
        },
        plugins: [
          nodeGlobalsPolyfillPlugin
        ]
      }
    },
    plugins: [react()]
  }
})
