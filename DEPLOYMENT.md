# Deployment

## Hosting doesn't affect processing speed

All video processing (trim, concat) runs client-side via ffmpeg.wasm, on
the user's own CPU. The server only ever serves static files — HTML, JS,
CSS, and the ffmpeg-core wasm/js. So the hosting choice has no effect on
how fast an export actually runs; it only affects:

1. **Initial load time** — how fast the ~32MB `ffmpeg-core.wasm` payload
   (plus the JS bundle) reaches the browser on first visit.
2. **Whether the host can set `Cross-Origin-Opener-Policy` /
   `Cross-Origin-Embedder-Policy` response headers** — the one lever that
   actually changes processing speed, because it's required to use
   ffmpeg.wasm's multi-threaded core build (`@ffmpeg/core-mt`), which uses
   `SharedArrayBuffer` for real multi-core encoding instead of the current
   single-threaded core.

## GitHub Pages

Works for this app (it's a pure static site, no backend needed). Its one
structural limitation: **GitHub Pages cannot set custom response
headers**, so COOP/COEP is not available there. That permanently caps a
GitHub Pages deployment at the single-threaded ffmpeg core — fine for
correctness, not the fastest possible option.

This repo is set up to deploy to GitHub Pages as a project page
(`master-max.github.io/linearEditComplete/`):

- `vite.config.js` sets `base: '/linearEditComplete/'` so Vite emits
  asset paths that resolve correctly under the subpath.
- `src/hooks/useFFmpeg.js` resolves `CORE_BASE` from
  `import.meta.env.BASE_URL` instead of `window.location.origin`, so the
  self-hosted ffmpeg core is fetched from the same subpath.
- `.github/workflows/deploy.yml` builds the app (`npm run build`) and
  publishes `dist/` via `actions/deploy-pages` on every push to `main`.
- `scripts/copy-classic-html.mjs` (run as part of `npm run build`)
  duplicates `dist/index.html` into `dist/classic/index.html` so a direct
  load of `/classic` works. GitHub Pages has no server-side rewrite to
  fall back to `index.html` for an unknown path the way a dev server's SPA
  middleware does, so the Classic layout's own URL needs a real file on
  disk; the app itself picks the layout from `location.pathname` (see
  `src/lib/route.js`).

To turn it on: in the repo's Settings → Pages, set **Source** to "GitHub
Actions". The workflow runs on the next push to `main` and publishes the
site at `https://master-max.github.io/linearEditComplete/`.

`ffmpeg-core.wasm` (~32MB) is well under GitHub's 50MB warning / 100MB hard
limit, so it commits fine without Git LFS.

## Recommendation for a performance-focused deployment: Cloudflare Pages

Same zero-cost static hosting and git-push deploy workflow as GitHub
Pages, but:

- Supports custom response headers via a `_headers` file, which unlocks
  setting COOP/COEP — the prerequisite for switching to the multi-threaded
  ffmpeg core and getting genuinely faster (multi-core) encoding.
- Sits on a fast global edge CDN, which matters more here than for a
  typical site given the size of the wasm payload on first load.
- No hosting migration needed later if/when the multi-threaded core is
  adopted — the headers can be added at that point without moving off the
  platform.

(Netlify and Vercel's static hosting are comparable alternatives with the
same header-configurability; Cloudflare Pages is called out here mainly
for being free at this scale with no bandwidth caveats.)

## Bottom line

- Ship on GitHub Pages today: fine, once the two path fixes above are in
  place. No perf loss versus any other static host for the *current*
  single-threaded build.
- Move to Cloudflare Pages (or Netlify/Vercel) only when/if adopting the
  multi-threaded ffmpeg core — that's the actual performance lever, and it
  requires header support GitHub Pages doesn't offer.
