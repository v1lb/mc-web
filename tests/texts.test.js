import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { setLanguage, t, plural, has, fileSize } from '../js/i18n.js';
import { itemLabel, itemValue, signalTitle, signalDetail, errorText, patchIssueText, exposureKindText } from '../js/texts.js';
import { catalog, filterCatalog, reportText, reportJson, reportFromJson, metadataCsv, historyCsv } from '../js/report.js';
import { analyzeFile } from '../js/core/analyze.js';
import { EXPOSURE_WEIGHT } from '../js/core/privacy.js';
import en from '../js/i18n/en.js';
import ru from '../js/i18n/ru.js';
import { webEn, webRu } from '../js/i18n/web.js';

const report = async (name) => (await analyzeFile(new File([readFileSync(new URL(`./fixtures/${name}`, import.meta.url))], name))).report;

test('every website string exists in both languages', () => {
  assert.deepEqual(Object.keys(webRu).sort(), Object.keys(webEn).sort());
  const placeholders = (s) => [...new Set((typeof s === 'string' ? s : Object.values(s).join(' ')).match(/%\d\$[sd]/g) ?? [])].sort().join();
  for (const key of Object.keys(webEn)) assert.equal(placeholders(webRu[key]), placeholders(webEn[key]), key);
  for (const key of Object.keys(ru)) assert.ok(key in en, key);
});

test('labels, values and signals are localized', async () => {
  const r = await report('photo.jpg');
  for (const lang of ['en', 'ru']) {
    setLanguage(lang);
    for (const item of [...r.exifSections.flatMap((s) => s.items), ...r.xmpItems]) {
      assert.doesNotMatch(itemLabel(item), /[a-z][A-Z]|:/, item.key);
    }
    for (const s of r.signals) { assert.ok(signalTitle(s).length > 3 && !signalTitle(s).startsWith('signal_')); assert.ok(signalDetail(s).length > 10); }
    for (const kind of Object.keys(EXPOSURE_WEIGHT)) assert.ok(has(`privacy_kind_${kind.toLowerCase()}`) && exposureKindText(kind));
  }
  setLanguage('en');
  const by = (key) => itemValue(r.exifSections.flatMap((s) => s.items).find((i) => i.key === key));
  assert.equal(by('exif:ExposureTime'), '1/250 s');
  assert.equal(by('exif:FNumber'), 'f/1.8');
  assert.equal(by('exif:Orientation'), 'Rotated 90° clockwise');
  assert.equal(t('onboarding_step', 2, 3), '02 / 03');
  assert.equal(plural('stamp_facts', 1), '1 FACT');
  assert.equal(plural('stamp_facts', 5), '5 FACTS');
  assert.equal(fileSize(1536), '1.5 KB');
  setLanguage('ru');
  assert.equal(by('exif:ExposureTime'), '1/250 с');
  assert.equal(plural('stamp_facts', 2), '2 ФАКТА');
  assert.match(errorText({ code: 'VIDEO_UNSUPPORTED' }), /видео/i);
  assert.match(errorText({ code: 'DAILY_LIMIT', limit: 10 }), /10/);
  assert.match(patchIssueText({ code: 'TEXT_NOT_ASCII', field: 'MAKE' }), /EXIF/);
  setLanguage('en');
});

test('catalog search, text report, JSON round trip and CSV', async () => {
  setLanguage('en');
  const r = await report('photo.jpg');
  const records = catalog(r);
  assert.ok(records.length > 25);
  assert.deepEqual(filterCatalog(records, null, 'shutter').map((x) => x.key).includes('exif:ExposureTime'), true);
  assert.ok(filterCatalog(records, 'LOCATION', '').every((x) => x.group === 'LOCATION'));
  assert.deepEqual(filterCatalog(records, null, 'hemisphere').map((x) => x.key), ['exif:GPSLatitudeRef', 'exif:GPSLongitudeRef']);
  assert.equal(filterCatalog(records, null, 'zzzz').length, 0);

  const text = reportText(r);
  assert.match(text, /^== MetaCheck: image report ==/);
  assert.match(text, /Make: TestMake/);
  assert.match(text, /Coordinates: 41\.89/);

  const json = reportJson(r);
  assert.deepEqual(reportFromJson(JSON.parse(JSON.stringify(json))), JSON.parse(JSON.stringify(r)));
  const noGps = reportJson(r, { includeGps: false, withTexts: true });
  assert.equal(noGps.gps, undefined);
  assert.equal(noGps.exif.some((s) => s.key === 'GPS'), false);
  assert.equal(JSON.stringify(noGps).includes('41.89'), false);
  assert.equal(noGps.exif[0].items[0].label, 'Make');

  const csvRaw = metadataCsv([{ group: 'MAIN', section: 'File', label: 'Name', value: '=cmd|"x"' }]);
  assert.deepEqual([...csvRaw.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.equal(new TextDecoder().decode(csvRaw), 'category,section,tag,value\r\n"General","File","Name","\'=cmd|""x"""\r\n');
  const history = new TextDecoder().decode(historyCsv([{ createdAt: 0, fileName: 'a.jpg', format: 'JPEG', hasAiEvidence: false, hasGps: true }]));
  assert.match(history, /"1970-01-01T00:00:00.000Z","a.jpg","JPEG","false","true"/);
});
