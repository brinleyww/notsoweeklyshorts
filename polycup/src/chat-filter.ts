const slurs = [
  'nigger',
  'niggers',
  'nigga',
  'niggas',
  'faggot',
  'faggots',
  'fag',
  'fags',
  'kike',
  'kikes',
  'spic',
  'spics',
  'chink',
  'chinks',
  'gook',
  'gooks',
  'wetback',
  'wetbacks',
  'raghead',
  'ragheads',
  'towelhead',
  'towelheads',
  'paki',
  'pakis',
  'tranny',
  'trannies',
  'retard',
  'retards',
  'retarded',
  'coon',
  'coons',
  'sandnigger',
  'sandniggers',
  'jigaboo',
  'jigaboos',
];
const groups =
  '(?:jews|jewish people|blacks|black people|muslims|gays|gay people|trans people|immigrants|women|romani|roma|asians|white people)';
const hate = [
  new RegExp(`\\b(?:kill|gas|exterminate|lynch)(?: all| the| all the)? ${groups}\\b`, 'g'),
  /\b(?:heil hitler|sieg heil|white power)\b/g,
];
const substitutions: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  а: 'a',
  е: 'e',
  і: 'i',
  о: 'o',
  с: 'c',
  р: 'p',
  ѕ: 's',
  х: 'x',
  у: 'y',
};
const patterns = slurs.map(
  (word) =>
    new RegExp(`(?<![a-z])${[...word].map((c) => `${c}+`).join('[\\s._*\\-]*')}(?![a-z])`, 'g'),
);

export function cleanChatText(text: string) {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function filterChat(text: string) {
  const original = [...text],
    normalized: string[] = [],
    positions: number[] = [];
  original.forEach((character, index) => {
    for (const c of character.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')) {
      if (/\p{Cf}/u.test(c)) continue;
      const mapped = substitutions[c] ?? c;
      for (let unit = 0; unit < mapped.length; unit++) {
        normalized.push(mapped[unit]);
        positions.push(index);
      }
    }
  });
  const source = normalized.join(''),
    masked = new Set<number>();
  for (const pattern of [...patterns, ...hate]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const first = positions[match.index!],
        last = positions[match.index! + match[0].length - 1];
      for (let i = first; i <= last; i++) if (!/\s/u.test(original[i])) masked.add(i);
    }
  }
  return original.map((c, i) => (masked.has(i) ? '*' : c)).join('');
}
