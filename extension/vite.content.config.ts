import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { resolve } from "path"

export default defineConfig({
  plugins: [react()],

  build: {
    outDir: "dist",
    emptyOutDir: false,

    rollupOptions: {
      input: resolve(__dirname, "src/content.tsx"),

      output: {
        format: "iife",
        entryFileNames: "content.js",
        inlineDynamicImports: true,
      },
    },
  },
})