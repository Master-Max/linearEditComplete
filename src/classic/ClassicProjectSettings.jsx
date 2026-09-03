import { RESOLUTION_PRESETS } from '../lib/resolution'

export default function ClassicProjectSettings({
  resolution,
  onResolutionChange,
  effectiveResolution,
  fitMode,
  onFitModeChange,
}) {
  const isAuto = resolution.mode === 'auto'

  function handlePreset(e) {
    const preset = RESOLUTION_PRESETS.find((p) => p.label === e.target.value)
    if (preset) onResolutionChange({ mode: 'manual', width: preset.width, height: preset.height })
  }

  return (
    <div className="part-box settings-box">
      <p className="clip-list-title">
        RESOLUTION —{' '}
        {effectiveResolution.width ? `${effectiveResolution.width}×${effectiveResolution.height}` : 'no clips yet'}
      </p>
      <div className="settings-row">
        <label className="settings-option">
          <input
            type="radio"
            name="classic-res-mode"
            checked={isAuto}
            onChange={() => onResolutionChange({ mode: 'auto', width: null, height: null })}
          />
          Auto
        </label>
        <label className="settings-option">
          <input
            type="radio"
            name="classic-res-mode"
            checked={!isAuto}
            onChange={() =>
              onResolutionChange({
                mode: 'manual',
                width: resolution.width ?? effectiveResolution.width ?? 1920,
                height: resolution.height ?? effectiveResolution.height ?? 1080,
              })
            }
          />
          Set explicitly
        </label>
        {!isAuto && (
          <select
            className="settings-select"
            onChange={handlePreset}
            value={
              RESOLUTION_PRESETS.find((p) => p.width === resolution.width && p.height === resolution.height)
                ?.label ?? ''
            }
          >
            <option value="" disabled>
              Choose…
            </option>
            {RESOLUTION_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="settings-row">
        <span className="settings-option">Fit mismatched clips</span>
        <select className="settings-select" value={fitMode} onChange={(e) => onFitModeChange(e.target.value)}>
          <option value="letterbox">Letterbox (black bars)</option>
          <option value="crop">Crop (fill frame)</option>
        </select>
      </div>
    </div>
  )
}
