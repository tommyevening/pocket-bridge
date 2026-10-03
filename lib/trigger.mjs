// Decides whether a Pocket recording is meant for the PMS: the trigger phrase (default "XTB news")
// must appear in the FIRST SENTENCE. Matching tolerates speech-to-text noise: case, Polish diacritics,
// punctuation/spaces between letters ("X T B, news"), and phonetic spellings ("iks te be news").

export const DEFAULT_TRIGGERS = ['xtb news', 'xtb newsy', 'xtb niusy', 'xtb njus', 'iks te be news', 'ikstebe news', 'ekstebe news', 'x tb news'];

// Fold one character at a time so indexes in the folded string map 1:1 to the original.
const DIA = { ł: 'l', Ł: 'L' };
const fold = (s) => [...s].map((c) => (DIA[c] || c.normalize('NFD')[0]).toLowerCase()).join('');

// "xtb news" -> /x[^a-z0-9]*t[^a-z0-9]*b[^a-z0-9]*n[^a-z0-9]*e[^a-z0-9]*w[^a-z0-9]*s/
const phraseRe = (p) => new RegExp([...fold(p).replace(/[^a-z0-9]/g, '')].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]*'));

// First sentence = up to the first . ! ? or newline; transcripts often lack punctuation, so also cap at 15 words.
export function firstSentence(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const end = t.search(/[.!?…](\s|$)|\n/);
  const sentence = end >= 0 ? t.slice(0, end + 1) : t;
  return sentence.split(' ').slice(0, 15).join(' ');
}

export function matchTrigger(text, phrases = DEFAULT_TRIGGERS) {
  const original = String(text || '').replace(/\s+/g, ' ').trim();
  const first = firstSentence(original);
  const folded = fold(first);
  for (const p of phrases) {
    const m = phraseRe(p).exec(folded);
    if (!m) continue;
    // Command = everything after the trigger ("XTB news, co Trump powiedział o cłach?" -> "co Trump powiedział o cłach?").
    // If the trigger ends the first sentence, the question is in the following sentences.
    let end = m.index + m[0].length;
    while (end < folded.length && /[a-z]/.test(folded[end])) end++; // finish the word: "news" -> "newsy"
    const command = original.slice(end).replace(/^[\s,.:;!?…–—-]+/, '').trim();
    return { matched: true, phrase: p, command: command || original };
  }
  return { matched: false, phrase: null, command: null };
}
