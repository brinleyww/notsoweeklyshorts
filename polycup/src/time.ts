// Native PolyTrack frames are milliseconds. Keep the whole value before splitting
// so crossing a minute cannot produce a 60-second field.
export function formatTime(frames: number) {
  if (!Number.isFinite(frames) || frames < 0) return '—';
  const ms = Math.floor(frames);
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
export function formatGap(frames: number) {
  if (!Number.isFinite(frames) || frames < 0) return '—';
  return `+${frames < 60000 ? (Math.floor(frames) / 1000).toFixed(3) : formatTime(frames)}`;
}
