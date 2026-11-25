// ffmpeg argument arrays. Spec: docs/helper-protocol.md "ffmpeg 인자".
// Arrays go straight to spawn(ffmpeg, args, { shell: false }); nothing here is
// ever joined into a shell string. All paths are absolute (validated upstream),
// so none can be mistaken for an option or a protocol prefix.

import path from 'node:path';

const HEAD = ['-hide_banner', '-nostdin', '-n'];
const TAIL = ['-progress', 'pipe:1', '-nostats'];
const AUDIO_INPUT_EXTS = new Set(['.aac', '.m4a', '.mp3']);
const AUDIO_OUTPUT_EXTS = new Set(['.m4a', '.mp3']);

/**
 * remux: copy streams into a new container.
 * Audio form (`-map 0:a`, no `-dn`) when the input is audio-only (.aac .m4a .mp3)
 * or the output is an audio container (.m4a .mp3); the video form otherwise.
 * @param {string} input absolute input path
 * @param {string} output absolute output path
 * @returns {string[]}
 */
export function remuxArgs(input, output) {
  const audio = AUDIO_INPUT_EXTS.has(path.extname(input).toLowerCase()) || AUDIO_OUTPUT_EXTS.has(path.extname(output).toLowerCase());
  const middle = audio
    ? ['-map', '0:a', '-c', 'copy', '-movflags', '+faststart']
    : ['-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-dn', '-movflags', '+faststart'];
  return [...HEAD, '-i', input, ...middle, ...TAIL, output];
}

/**
 * merge: one video + optional separate audio + optional subtitle files.
 * Without a separate audio file the input numbers of the subtitles shift down by
 * one, and the video file's own audio (if any) is kept with `-map 0:a?`.
 * Subtitles become mov_text (mp4) or srt (mkv, which cannot hold mov_text) and
 * get `language=` only when their tag maps to a 3-letter ISO 639-2 code.
 * @param {{video: string, audio?: string, subtitles?: Array<{path: string, lang?: string}>, output: string}} job
 * @returns {string[]}
 */
export function mergeArgs({ video, audio, subtitles = [], output }) {
  const inputs = ['-i', video];
  const maps = ['-map', '0:v:0'];
  if (audio) {
    inputs.push('-i', audio);
    maps.push('-map', '1:a:0');
  } else {
    maps.push('-map', '0:a?');
  }
  const firstSub = audio ? 2 : 1;
  subtitles.forEach((s, i) => {
    inputs.push('-i', s.path);
    maps.push('-map', `${firstSub + i}:0`);
  });
  const subOpts = [];
  if (subtitles.length) {
    subOpts.push('-c:s', path.extname(output).toLowerCase() === '.mkv' ? 'srt' : 'mov_text');
    subtitles.forEach((s, i) => {
      const code = toIso639_2(s.lang);
      if (code) subOpts.push(`-metadata:s:s:${i}`, `language=${code}`);
    });
  }
  return [...HEAD, ...inputs, ...maps, '-c:v', 'copy', '-c:a', 'copy', ...subOpts, '-movflags', '+faststart', ...TAIL, output];
}

// ISO 639-1 -> ISO 639-2/T (the form ISO BMFF stores in mdhd). ffmpeg's mp4
// muxer silently drops a 2-letter value (verified on ffmpeg 9.0.2: language=en
// left no tag, language=kor stuck), so 2-letter tags must be converted.
const ISO639_1_TO_2 = Object.freeze(Object.fromEntries(
  ('aa:aar ab:abk af:afr ak:aka am:amh an:arg ar:ara as:asm av:ava ay:aym az:aze ba:bak be:bel bg:bul bi:bis '
  + 'bm:bam bn:ben bo:bod br:bre bs:bos ca:cat ce:che ch:cha co:cos cr:cre cs:ces cu:chu cv:chv cy:cym da:dan '
  + 'de:deu dv:div dz:dzo ee:ewe el:ell en:eng eo:epo es:spa et:est eu:eus fa:fas ff:ful fi:fin fj:fij fo:fao '
  + 'fr:fra fy:fry ga:gle gd:gla gl:glg gn:grn gu:guj gv:glv ha:hau he:heb hi:hin ho:hmo hr:hrv ht:hat hu:hun '
  + 'hy:hye hz:her ia:ina id:ind ie:ile ig:ibo ii:iii ik:ipk in:ind io:ido is:isl it:ita iu:iku iw:heb ja:jpn '
  + 'ji:yid jv:jav ka:kat kg:kon ki:kik kj:kua kk:kaz kl:kal km:khm kn:kan ko:kor kr:kau ks:kas ku:kur kv:kom '
  + 'kw:cor ky:kir la:lat lb:ltz lg:lug li:lim ln:lin lo:lao lt:lit lu:lub lv:lav mg:mlg mh:mah mi:mri mk:mkd '
  + 'ml:mal mn:mon mr:mar ms:msa mt:mlt my:mya na:nau nb:nob nd:nde ne:nep ng:ndo nl:nld nn:nno no:nor nr:nbl '
  + 'nv:nav ny:nya oc:oci oj:oji om:orm or:ori os:oss pa:pan pi:pli pl:pol ps:pus pt:por qu:que rm:roh rn:run '
  + 'ro:ron ru:rus rw:kin sa:san sc:srd sd:snd se:sme sg:sag si:sin sk:slk sl:slv sm:smo sn:sna so:som sq:sqi '
  + 'sr:srp ss:ssw st:sot su:sun sv:swe sw:swa ta:tam te:tel tg:tgk th:tha ti:tir tk:tuk tl:tgl tn:tsn to:ton '
  + 'tr:tur ts:tso tt:tat tw:twi ty:tah ug:uig uk:ukr ur:urd uz:uzb ve:ven vi:vie vo:vol wa:wln wo:wol xh:xho '
  + 'yi:yid yo:yor za:zha zh:zho zu:zul')
    .split(' ')
    .map((pair) => pair.split(':')),
));

/**
 * Convert a language tag ("en", "en-US", "pt_BR", "kor") to a 3-letter code.
 * @param {unknown} lang
 * @returns {string|null} lower-case ISO 639-2 code, or null when unknown/invalid.
 */
export function toIso639_2(lang) {
  if (typeof lang !== 'string') return null;
  const m = /^([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]{1,8})*$/.exec(lang.trim());
  if (!m) return null;
  const primary = m[1].toLowerCase();
  if (primary.length === 3) return primary;
  return ISO639_1_TO_2[primary] ?? null;
}
