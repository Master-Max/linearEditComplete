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

// https://vite.dev/config/
export default defineConfig({
  base: '/linearEditComplete/',
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_COMMIT_HASH': JSON.stringify(getCommitHash()),
  },
})
