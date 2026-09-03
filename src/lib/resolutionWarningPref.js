const KEY = 'linearEdit.hideResolutionMismatchWarning'

export function isResolutionWarningDismissed() {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

export function dismissResolutionWarningPermanently() {
  try {
    localStorage.setItem(KEY, 'true')
  } catch {
    // Private mode / storage disabled — the popup will just keep reappearing.
  }
}
