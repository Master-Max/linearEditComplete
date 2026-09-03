import { RESOLUTION_PRESETS } from '../lib/resolution'

export default function ProjectSettings({
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
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs text-slate-600">
      <span className="font-medium text-slate-700">Project resolution</span>

      <label className="flex items-center gap-1">
        <input
          type="radio"
          name="res-mode"
          checked={isAuto}
          onChange={() => onResolutionChange({ mode: 'auto', width: null, height: null })}
        />
        Auto (matches first clip)
      </label>

      <label className="flex items-center gap-1">
        <input
          type="radio"
          name="res-mode"
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
          className="rounded border border-slate-200 px-2 py-1"
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

      <span className="text-slate-400">
        {effectiveResolution.width
          ? `Currently ${effectiveResolution.width}×${effectiveResolution.height}`
          : 'No clips yet'}
      </span>

      <span className="ml-auto flex items-center gap-2">
        <span className="font-medium text-slate-700">Fit mismatched clips</span>
        <select
          className="rounded border border-slate-200 px-2 py-1"
          value={fitMode}
          onChange={(e) => onFitModeChange(e.target.value)}
        >
          <option value="letterbox">Letterbox (black bars)</option>
          <option value="crop">Crop (fill frame)</option>
        </select>
      </span>
    </div>
  )
}
