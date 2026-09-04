// No router library - this app only ever has two "pages" (modern/classic),
// so a full router is more machinery than the problem needs. Instead we
// read/write window.location directly and pair it with a build step that
// duplicates index.html into classic/index.html (see scripts/), since
// GitHub Pages has no server-side rewrites to fall back to index.html for
// a direct hit on /classic.
const CLASSIC_SEGMENT = 'classic'

function basePath() {
  return import.meta.env.BASE_URL
}

export function getLayoutFromLocation() {
  const base = basePath()
  const path = window.location.pathname
  if (!path.startsWith(base)) return 'modern'
  const rest = path.slice(base.length).replace(/^\/+|\/+$/g, '')
  return rest === CLASSIC_SEGMENT ? 'classic' : 'modern'
}

export function pathForLayout(layout) {
  const base = basePath()
  return layout === 'classic' ? `${base}${CLASSIC_SEGMENT}` : base
}

export function navigateToLayout(layout) {
  const path = pathForLayout(layout)
  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path)
  }
}
