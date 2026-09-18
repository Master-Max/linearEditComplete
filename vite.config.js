import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Shown in the footer (see App.jsx) so a deployed build can be matched back
// to the commit it came from. Falls back to 'dev' rather than failing the
// build if there's no .git available (e.g. a tarball install) - this is a
// diagnostic label, not something anything depends on.
function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

// Cross-origin isolation (COOP/COEP), so the multi-threaded ffmpeg.wasm
// core (see useFFmpeg.js) can actually be exercised via `npm run dev` /
// `npm run preview` - SharedArrayBuffer, which it needs, only exists on a
// cross-origin-isolated page. This only configures Vite's own dev/preview
// servers; it has no effect on the static files GitHub Pages serves in
// production, which is why this alone doesn't turn multi-threading on for
// deployed users - see the "scrub-proxy transcode is single-threaded" entry
// in TECHDEBT.md for what actually would.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// GitHub Pages serves this as a project site (username.github.io/repo-name/),
// so every asset URL needs that path prefix - but Vercel serves the same
// build from its domain root, where that prefix would just 404 every script
// and stylesheet tag (a blank page, not a visible error). Vercel sets
// VERCEL=1 in its build environment automatically, so this needs no
// per-target configuration - the same `vite build` picks the right base for
// whichever host actually ran it.
const isVercel = process.env.VERCEL === '1'

// https://vite.dev/config/
export default defineConfig({
  base: isVercel ? '/' : '/linearEditComplete/',
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_COMMIT_HASH': JSON.stringify(getCommitHash()),
  },
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
})
