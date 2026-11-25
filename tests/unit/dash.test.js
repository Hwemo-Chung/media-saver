import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../../extension/lib/xml.js';
import { parseMpd, parseIsoDuration, expandTemplate } from '../../extension/lib/dash.js';

test('parseXml builds a tree, skipping declaration/comments, decoding entities and CDATA', () => {
  const doc = parseXml(`<?xml version="1.0"?>
<!-- comment -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" a="1&amp;2"><Period id='p0'><BaseURL>http://x/&lt;y&gt;/</BaseURL><Empty/><![CDATA[raw <b>]]></Period></MPD>`);
  assert.equal(doc.name, 'MPD');
  assert.equal(doc.attrs.a, '1&2');
  const period = doc.children[0];
  assert.equal(period.name, 'Period');
  assert.equal(period.attrs.id, 'p0');
  assert.equal(period.children[0].text, 'http://x/<y>/');
  assert.equal(period.children[1].name, 'Empty');
  assert.match(period.text, /raw <b>/);
});

test('parseXml strips namespace prefixes into localName', () => {
  const doc = parseXml('<mpd:MPD xmlns:mpd="u"><mpd:Period/><cenc:pssh xmlns:cenc="c">AAA</cenc:pssh></mpd:MPD>');
  assert.equal(doc.name, 'MPD');
  assert.equal(doc.children[0].name, 'Period');
  assert.equal(doc.children[1].name, 'pssh');
});

test('parseIsoDuration', () => {
  assert.equal(parseIsoDuration('PT12S'), 12);
  assert.equal(parseIsoDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration('PT0.04S'), 0.04);
  assert.equal(parseIsoDuration(undefined), 0);
});

test('expandTemplate handles identifiers, width formats and $$', () => {
  assert.equal(expandTemplate('seg-$RepresentationID$-$Number%05d$.m4s', { RepresentationID: 'v1', Number: 42 }), 'seg-v1-00042.m4s');
  assert.equal(expandTemplate('$Time$_$Bandwidth$$$.m4s', { Time: 9000, Bandwidth: 800 }), '9000_800$.m4s');
});

const TIMELINE = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12.0S" minBufferTime="PT2S">
  <BaseURL>media/</BaseURL>
  <Period id="0" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="1000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Time$.m4s" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="1"/>
          <S d="4000"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="0" bandwidth="800000" width="640" height="360" codecs="avc1.64001e"/>
      <Representation id="1" bandwidth="2400000" width="1280" height="720" codecs="avc1.64001f"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="2" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000">
        <SegmentTemplate timescale="48000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%03d$.m4s" startNumber="1">
          <SegmentTimeline><S t="0" d="96000" r="-1"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test('parseMpd: SegmentTemplate + SegmentTimeline (r and r=-1), BaseURL resolution, sorting', () => {
  const m = parseMpd(TIMELINE, 'https://cdn.test/show/manifest.mpd?sig=1');
  assert.equal(m.type, 'static');
  assert.equal(m.duration, 12);
  assert.equal(m.drm, false);
  assert.equal(m.video.length, 2);
  const hi = m.video[0];
  assert.equal(hi.height, 720);
  assert.equal(hi.init.url, 'https://cdn.test/show/media/init-1.m4s');
  assert.deepEqual(hi.segments.map((s) => s.url), [
    'https://cdn.test/show/media/chunk-1-0.m4s',
    'https://cdn.test/show/media/chunk-1-4000.m4s',
    'https://cdn.test/show/media/chunk-1-8000.m4s',
  ]);
  const a = m.audio[0];
  assert.equal(a.lang, 'en');
  // r=-1 repeats until the end of the period: 12 s / 2 s = 6 segments
  assert.equal(a.segments.length, 6);
  assert.equal(a.segments[5].url, 'https://cdn.test/show/media/chunk-2-006.m4s');
});

test('parseMpd: SegmentTemplate with duration and $Number$', () => {
  const xml = `<MPD type="static" mediaPresentationDuration="PT10S"><Period>
    <AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" width="320" height="180">
      <SegmentTemplate timescale="90000" duration="360000" startNumber="5" initialization="v/init.mp4" media="v/$Number$.m4s"/>
    </Representation></AdaptationSet></Period></MPD>`;
  const m = parseMpd(xml, 'https://h.test/a/b.mpd');
  const v = m.video[0];
  assert.equal(v.segments.length, 3); // ceil(10 / 4)
  assert.deepEqual(v.segments.map((s) => s.url), ['https://h.test/a/v/5.m4s', 'https://h.test/a/v/6.m4s', 'https://h.test/a/v/7.m4s']);
});

test('parseMpd: SegmentBase / whole-file BaseURL and SegmentList', () => {
  const xml = `<MPD type="static" mediaPresentationDuration="PT8S"><Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v" bandwidth="5" width="1920" height="1080"><BaseURL>video_1080.mp4</BaseURL><SegmentBase indexRange="800-1000"><Initialization range="0-799"/></SegmentBase></Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1">
      <SegmentList duration="4" timescale="1"><Initialization sourceURL="a/init.mp4"/><SegmentURL media="a/1.m4s"/><SegmentURL media="a/all.m4s" mediaRange="100-199"/></SegmentList>
    </Representation></AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="ko"><Representation id="t" bandwidth="1"><BaseURL>subs/ko.vtt</BaseURL></Representation></AdaptationSet>
  </Period></MPD>`;
  const m = parseMpd(xml, 'https://s.test/x/manifest.mpd');
  assert.equal(m.video[0].single, true);
  assert.deepEqual(m.video[0].segments, [{ url: 'https://s.test/x/video_1080.mp4', range: null }]);
  assert.equal(m.video[0].init, null);
  const a = m.audio[0];
  assert.equal(a.init.url, 'https://s.test/x/a/init.mp4');
  assert.deepEqual(a.segments, [
    { url: 'https://s.test/x/a/1.m4s', range: null },
    { url: 'https://s.test/x/a/all.m4s', range: { offset: 100, length: 100 } },
  ]);
  assert.equal(m.text.length, 1);
  assert.equal(m.text[0].lang, 'ko');
  assert.equal(m.text[0].segments[0].url, 'https://s.test/x/subs/ko.vtt');
});

test('parseMpd: ContentProtection marks DRM; dynamic type is reported; multi-period counted', () => {
  const xml = `<MPD type="dynamic" availabilityStartTime="2020-01-01T00:00:00Z"><Period id="a">
    <AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v" bandwidth="1"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet></Period><Period id="b"/></MPD>`;
  const m = parseMpd(xml, 'https://d.test/m.mpd');
  assert.equal(m.drm, true);
  assert.equal(m.type, 'dynamic');
  assert.equal(m.periodCount, 2);
});

test('parseMpd: video adaptation that muxes audio is detected via codecs; mimeType on representation', () => {
  const xml = `<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet>
    <Representation id="av" mimeType="video/mp4" codecs="avc1.4d401f,mp4a.40.2" bandwidth="9" width="640" height="360"><BaseURL>av.mp4</BaseURL></Representation>
    <Representation id="ao" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="1"><BaseURL>ao.m4a</BaseURL></Representation>
  </AdaptationSet></Period></MPD>`;
  const m = parseMpd(xml, 'https://d.test/m.mpd');
  assert.equal(m.video.length, 1);
  assert.equal(m.video[0].hasAudio, true);
  assert.equal(m.audio.length, 1);
});
