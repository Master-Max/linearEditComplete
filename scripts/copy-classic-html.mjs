// GitHub Pages serves static files only, with no server-side rewrite to
// fall back to index.html for unknown paths - so a direct load (or
// refresh) of /classic needs a real classic/index.html file to exist.
// This duplicates the built index.html there; the app itself reads
// location.pathname (see src/lib/route.js) to pick which layout to show.
import { mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'dist')
const classicDir = join(distDir, 'classic')

mkdirSync(classicDir, { recursive: true })
copyFileSync(join(distDir, 'index.html'), join(classicDir, 'index.html'))
console.log('Copied dist/index.html -> dist/classic/index.html for the /classic route.')
