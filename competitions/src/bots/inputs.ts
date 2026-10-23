// A bot's run as the TAS tool's text: one "frame,keys" line per change of keys, keys from w/a/s/d/r
// (up/left/down/right/reset) in that order, each line holding until the next. Frame f is the physics step
// taken f ms after the run's start, as in a recording.
const KEYS: [number, string][] = [
  [1, 'w'],
  [8, 'a'],
  [4, 's'],
  [2, 'd'],
  [16, 'r'],
];

export function inputsText(keys: Uint8Array) {
  const lines: string[] = [];
  let prev = '';
  for (let f = 0; f < keys.length; f++) {
    let k = '';
    for (const [bit, c] of KEYS) if (keys[f] & bit) k += c;
    if (k === prev) continue;
    lines.push(`${f},${k}`);
    prev = k;
  }
  return lines.join('\n') + '\n';
}
