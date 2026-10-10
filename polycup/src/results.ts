import { currentMatch, player } from './cup.ts';
import type { CupState } from './types.ts';

export function resultRows(state: CupState) {
  const match = currentMatch(state);
  if (state.phase !== 'complete' || !match?.winners.length) return [];
  return state.results.map(({ id, place }) => ({
    id,
    place,
    name: player(state, id)?.name ?? 'Racer',
    score: match.scores[id],
    winner: match.winners.includes(id),
  }));
}

// Draw only public results. Lobby codes, peer IDs and profile identifiers never enter the image.
export async function resultsImage(
  state: CupState,
  thumbnail: (id: number) => Promise<string | null>,
) {
  const rows = resultRows(state);
  if (!rows.length) throw new Error('Finish the Cup before saving a results image.');
  await document.fonts.load('italic 32px ForcedSquare');
  const images = await Promise.all(
    rows.map(async (r) => {
      try {
        const url = await thumbnail(r.id);
        if (!url) return null;
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
      } catch {
        return null;
      }
    }),
  );
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 286 + rows.length * 82;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#192042';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const shape = (x: number, y: number, w: number, height: number, color: string, cut = 12) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + cut, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - cut, y + height);
    ctx.lineTo(x, y + height);
    ctx.closePath();
    ctx.fill();
  };
  const text = (
    value: string | number,
    x: number,
    y: number,
    size: number,
    color = '#ffffff',
    align: CanvasTextAlign = 'left',
    max = 1000,
  ) => {
    ctx.font = `italic ${size}px ForcedSquare`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    let label = String(value);
    while (label.length > 1 && ctx.measureText(label).width > max) label = label.slice(0, -2) + '…';
    ctx.fillText(label, x, y);
  };
  shape(0, 0, 1200, 10, '#ffd26b', 0);
  text('PolyCup', 52, 80, 52);
  text(state.name, 52, 127, 30, '#b3c7df', 'left', 1080);
  text('FINAL STANDINGS', 600, 186, 34, '#ffffff', 'center');
  rows.forEach((r, i) => {
    const y = 212 + i * 82,
      ink = r.winner ? '#192042' : '#ffffff';
    shape(44, y, 1112, 68, r.winner ? '#ffd26b' : '#28346a');
    text(r.place, 82, y + 44, 30, ink);
    if (images[i]) {
      const image = images[i],
        scale = Math.min(90 / image.width, 60 / image.height);
      const w = image.width * scale,
        h = image.height * scale;
      ctx.drawImage(image, 118 + (90 - w) / 2, y + 4 + (60 - h) / 2, w, h);
    }
    text(r.name, 225, y + 44, 32, ink, 'left', 610);
    if (r.winner) text('WINNER', 840, y + 44, 25, ink);
    shape(992, y + 8, 146, 52, '#e9f1f8', 10);
    text(r.score, 1065, y + 43, 32, '#192042', 'center');
  });
  const maps = state.tracks.map((t) => t.name).join(' / ');
  text(maps, 52, canvas.height - 28, 24, '#b3c7df', 'left', 1090);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not save the results image.'))),
      'image/png',
    ),
  );
}
