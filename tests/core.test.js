import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto, generateKeyPairSync, createSign } from 'node:crypto';

import { analyzeFile } from '../js/core/analyze.js';
import { cleanImage } from '../js/core/clean.js';
import { applyPatch, wipeGps, shiftJpegDates, validatePatch, shiftDate, shiftSeconds, editableFields } from '../js/core/edit.js';
import { inspectJpeg, isStrippedJpeg, stripJpeg } from '../js/core/jpeg.js';
import { readExif } from '../js/core/exif.js';
import { cleanVideo, isCleanVideo } from '../js/core/mp4clean.js';
import { parseIso6709 } from '../js/core/mp4.js';
import { evaluateSignals, toolMarker, copySource } from '../js/core/signals.js';
import { privacyExposure, hasAiEvidence, needsAiReview } from '../js/core/privacy.js';
import { readC2pa } from '../js/core/c2pa.js';
import { valuesOf, parseXmp } from '../js/core/xmp.js';
import { verifyLicense } from '../js/core/license.js';
import { zipBlob, uniqueName } from '../js/core/zip.js';
import { detectFormat } from '../js/core/format.js';
import { concat, ascii, putU32, crc32 } from '../js/core/bytes.js';

const fx = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const file = (name) => new File([fx(name)], name);
const analyze = async (bytes, name) => (await analyzeFile(new File([bytes], name))).report;
const field = (report, key) => [...report.exifSections.flatMap((s) => s.items), ...report.xmpItems].find((i) => i.key === key)?.value;
const kinds = (report) => report.signals.map((s) => s.kind);

test('JPEG: EXIF, GPS, XMP and IPTC are read', async () => {
  const { report, exif } = await analyzeFile(file('photo.jpg'));
  assert.equal(report.file.format, 'JPEG');
  assert.equal(field(report, 'exif:Make'), 'TestMake');
  assert.equal(field(report, 'exif:Model'), 'TestModel X');
  assert.equal(field(report, 'exif:DateTimeOriginal'), '2024:06:15 19:42:10');
  assert.equal(field(report, 'exif:BodySerialNumber'), 'SN123456');
  assert.equal(Number(field(report, 'exif:ExposureTime')), 0.004);
  assert.equal(Number(field(report, 'exif:FNumber')), 1.8);
  assert.equal(field(report, 'exif:PhotographicSensitivity'), '200');
  assert.ok(Math.abs(report.gps.latitude - 41.8902) < 1e-4 && Math.abs(report.gps.longitude - 12.4923) < 1e-4);
  assert.equal(report.gps.altitudeMeters, 50);
  assert.equal(field(report, 'xmp:xmp:CreatorTool'), 'Adobe Lightroom 7.0');
  assert.equal(field(report, 'xmp:dc:creator'), 'Jane Doe');
  assert.equal(field(report, 'iptc:Keywords'), 'beach');
  assert.equal(field(report, 'iptc:City'), undefined, 'the IPTC city repeats the XMP value and is not shown twice');
  assert.equal(exif.orientation, 6);
  assert.ok(kinds(report).includes('HAS_GPS') && kinds(report).includes('NO_AI_TRACES'));
  assert.equal(hasAiEvidence(report), false);
  const exposure = privacyExposure(report);
  assert.equal(exposure.level, 'HIGH');
  assert.deepEqual(exposure.items.slice(0, 3).map((i) => i.kind), ['EXACT_LOCATION', 'DEVICE_SERIAL', 'PLACE_NAME']);
  assert.equal(exposure.items.find((i) => i.kind === 'DEVICE').value, 'TestMake TestModel X');
});

test('JPEG: cleaning keeps the picture and orientation only', async () => {
  const source = fx('photo.jpg');
  const before = inspectJpeg(source);
  assert.ok(before.exif && before.xmp && before.iptc && before.comment && before.trailer);
  const clean = cleanImage(source, 'JPEG');
  assert.ok(isStrippedJpeg(clean));
  const report = await analyze(clean, 'photo.jpg');
  assert.equal(report.gps, null);
  assert.deepEqual(report.exifSections.flatMap((s) => s.items).map((i) => i.key), ['exif:Orientation']);
  assert.equal(report.xmpItems.length, 0);
  assert.equal(privacyExposure(report).level, 'NONE');
  assert.equal(Buffer.from(clean).includes('TRAILER'), false);
  // Scan data is copied byte for byte.
  const scan = (d) => { const at = Buffer.from(d).indexOf(Buffer.from([0xFF, 0xDA])); return Buffer.from(d.subarray(at, at + 400)); };
  assert.ok(scan(source).equals(scan(clean)));
  assert.ok(isStrippedJpeg(cleanImage(fx('plain.jpg'), 'JPEG')));
  assert.equal(isStrippedJpeg(source), false);
});

test('JPEG: GPS-only removal keeps camera and date', async () => {
  const { bytes, verified } = wipeGps(fx('photo.jpg'), 'JPEG');
  assert.ok(verified);
  const report = await analyze(bytes, 'photo.jpg');
  assert.equal(report.gps, null);
  assert.equal(report.exifSections.some((s) => s.key === 'GPS'), false);
  assert.equal(field(report, 'exif:Make'), 'TestMake');
  assert.equal(field(report, 'exif:DateTimeOriginal'), '2024:06:15 19:42:10');
  assert.equal(report.xmpItems.length, 0, 'XMP with a copy of the coordinates is dropped');
  assert.equal(inspectJpeg(bytes).hidden, false);
});

test('JPEG: editor writes and verifies fields', async () => {
  const patch = { latitude: -33.8568, longitude: 151.2153, make: 'Acme', model: 'Cam 2', author: 'A. Author', dateTaken: '2020:01:02 03:04:05',
    iso: 400, aperture: 2.8, exposureSeconds: 0.02, description: 'Edited' };
  const { bytes, verified } = applyPatch(fx('photo.jpg'), patch);
  assert.ok(verified);
  const report = await analyze(bytes, 'x.jpg');
  assert.ok(Math.abs(report.gps.latitude + 33.8568) < 1e-5 && Math.abs(report.gps.longitude - 151.2153) < 1e-5);
  assert.equal(field(report, 'exif:Make'), 'Acme');
  assert.equal(field(report, 'exif:DateTimeOriginal'), '2020:01:02 03:04:05');
  assert.equal(field(report, 'exif:PhotographicSensitivity'), '400');
  assert.equal(field(report, 'exif:BodySerialNumber'), 'SN123456', 'untouched tags stay');
  assert.equal(field(report, 'exif:GPSLatitudeRef'), 'S');

  const removed = applyPatch(fx('photo.jpg'), { removeGps: true });
  assert.ok(removed.verified);
  assert.equal((await analyze(removed.bytes, 'x.jpg')).gps, null);

  const fresh = applyPatch(fx('plain.jpg'), { latitude: 10.5, longitude: 20.25, copyright: '(c) me' });
  assert.ok(fresh.verified, 'EXIF is created when the file had none');

  assert.throws(() => applyPatch(fx('ai.png'), { make: 'x' }), /EDIT_JPEG_ONLY/);
  assert.deepEqual(validatePatch({}).map((i) => i.code), ['NO_CHANGES']);
  assert.deepEqual(validatePatch({ latitude: 91, make: 'Камера', dateTaken: '2024-01-01' }).map((i) => i.code),
    ['GPS_INCOMPLETE', 'LATITUDE_RANGE', 'TEXT_NOT_ASCII', 'DATE_FORMAT']);
  assert.deepEqual(validatePatch({ removeGps: true, latitude: 1, longitude: 1, iso: 0 }).map((i) => i.code), ['GPS_REMOVE_AND_SET', 'ISO_RANGE']);
});

test('dates: shifting and copying fields', () => {
  assert.equal(shiftDate('2024:06:15 23:30:00', 3600), '2024:06:16 00:30:00');
  assert.equal(shiftDate('2024:03:01 00:10:00', -1800), '2024:02:29 23:40:00');
  assert.equal(shiftDate('0000:00:00 00:00:00', 60), null);
  assert.equal(shiftSeconds(true, '2', '30'), -9000);
  assert.equal(shiftSeconds(false, '0', '0'), null);
  assert.equal(shiftSeconds(false, '1', '60'), null);
  const shifted = shiftJpegDates(fx('photo.jpg'), -7200);
  assert.ok(shifted.verified);
  const exif = readExif(shifted.bytes, 'JPEG');
  const fields = editableFields(exif);
  assert.equal(fields.dateTaken, '2024:06:15 17:42:10');
  assert.equal(fields.make, 'TestMake');
  assert.equal(fields.latitude, '41.8902');
  assert.throws(() => shiftJpegDates(fx('plain.jpg'), 60), /NO_DATE_TO_SHIFT/);
});

test('PNG: generation parameters, text blocks and cleaning', async () => {
  const report = await analyze(fx('ai.png'), 'ai.png');
  assert.ok(hasAiEvidence(report));
  assert.ok(kinds(report).includes('SD_PARAMETERS') && kinds(report).includes('AI_TOOL_FIELD'));
  assert.deepEqual(report.pngTextItems.map((i) => i.label), ['parameters', 'Software']);
  assert.equal(field(report, 'xmp:photoshop:City'), 'Roma');
  assert.equal(field(report, 'exif:Make'), 'TestMake');
  assert.ok(report.gps);
  assert.ok(privacyExposure(report).items.some((i) => i.kind === 'AI_PROMPT'));

  const gpsFree = wipeGps(fx('ai.png'), 'PNG');
  const afterGps = await analyze(gpsFree.bytes, 'ai.png');
  assert.equal(afterGps.gps, null);
  assert.equal(field(afterGps, 'exif:Make'), 'TestMake');
  assert.ok(kinds(afterGps).includes('SD_PARAMETERS'), 'only location data goes away');

  const clean = cleanImage(fx('ai.png'), 'PNG');
  const after = await analyze(clean, 'ai.png');
  assert.equal(hasAiEvidence(after), false);
  assert.ok(kinds(after).includes('NO_METADATA'));
  assert.equal(Buffer.from(clean).includes('AFTER-IEND'), false);
});

test('WebP, GIF and HEIC: read and clean without recompression', async () => {
  const webp = await analyze(fx('photo.webp'), 'photo.webp');
  assert.equal(webp.file.format, 'WEBP');
  assert.ok(webp.gps);
  assert.equal(field(webp, 'xmp:xmp:CreatorTool'), 'Adobe Lightroom 7.0');
  const webpClean = await analyze(cleanImage(fx('photo.webp'), 'WEBP'), 'photo.webp');
  assert.ok(kinds(webpClean).includes('NO_METADATA'));
  const webpGps = await analyze(wipeGps(fx('photo.webp'), 'WEBP').bytes, 'photo.webp');
  assert.equal(webpGps.gps, null);
  assert.equal(field(webpGps, 'exif:Model'), 'TestModel X');

  const gif = await analyze(fx('anim.gif'), 'anim.gif');
  assert.deepEqual(gif.pngTextItems, [{ label: 'Comment', value: 'made by tester' }]);
  const gifClean = cleanImage(fx('anim.gif'), 'GIF');
  assert.ok(kinds(await analyze(gifClean, 'anim.gif')).includes('NO_METADATA'));
  assert.ok(Buffer.from(gifClean).includes('NETSCAPE2.0'), 'the animation loop stays');

  const heic = await analyze(fx('gps_sample.heic'), 'gps_sample.heic');
  assert.equal(heic.file.format, 'HEIC');
  assert.ok(heic.gps, 'HEIC GPS is read');
  const source = fx('gps_sample.heic');
  const heicClean = cleanImage(source, 'HEIC');
  assert.equal(heicClean.length, source.length, 'metadata is overwritten in place');
  const afterHeic = await analyze(heicClean, 'gps_sample.heic');
  assert.equal(afterHeic.gps, null);
  assert.equal(afterHeic.exifSections.length, 0);
  const heicGps = await analyze(wipeGps(source, 'HEIC').bytes, 'gps_sample.heic');
  assert.equal(heicGps.gps, null);
  assert.ok(heicGps.exifSections.some((s) => s.key === 'CAMERA'), 'camera fields stay after GPS-only removal');
});

test('video: tags are read and removed without re-encoding', async () => {
  for (const name of ['clip.mp4', 'clip.mov']) {
    const { report } = await analyzeFile(file(name));
    assert.equal(report.file.format, name.endsWith('mov') ? 'MOV' : 'MP4');
    assert.ok(report.gps && Math.abs(report.gps.latitude - 41.8902) < 1e-4, `${name}: location`);
    const title = name.endsWith('mp4') ? field(report, 'video:title')
      : report.exifSections.find((s) => s.key === 'CONTAINER').items.find((i) => i.label === 'title').value;
    assert.equal(title, 'Holiday clip');
    assert.ok(field(report, 'video:duration'));
    assert.ok(kinds(report).includes('HAS_GPS'));
    assert.equal(await isCleanVideo(file(name)), false);

    const result = await cleanVideo(file(name));
    assert.ok(await isCleanVideo(result.blob), `${name}: verified clean`);
    const after = (await analyzeFile(new File([result.blob], name))).report;
    assert.equal(after.gps, null);
    assert.deepEqual(after.exifSections.map((s) => s.key), ['IMAGE']);
    assert.equal(field(after, 'video:created'), undefined);
    assert.ok(kinds(after).includes('NO_METADATA'));
    assert.equal(field(after, 'video:duration'), field(report, 'video:duration'));
  }
  await assert.rejects(cleanVideo(file('fragmented.mp4')), /VIDEO_UNSUPPORTED/);
  assert.deepEqual(parseIso6709('+41.8902+012.4923+050.000/'), { latitude: 41.8902, longitude: 12.4923, altitudeMeters: 50 });
  const dm = parseIso6709('+4153.41+01229.54');
  assert.ok(Math.abs(dm.latitude - 41.8902) < 1e-3 && Math.abs(dm.longitude - 12.4923) < 1e-3);
  assert.equal(parseIso6709('+00.0000+000.0000/'), null);
});

test('video: cleaned stream data is identical', async () => {
  const source = fx('clip.mp4');
  const result = await cleanVideo(new File([source], 'clip.mp4'));
  const out = new Uint8Array(await result.blob.arrayBuffer());
  const mdat = (d) => { const at = Buffer.from(d).indexOf('mdat'); const size = new DataView(d.buffer, d.byteOffset).getUint32(at - 4); return Buffer.from(d.subarray(at + 4, at - 4 + size)); };
  assert.ok(mdat(source).equals(mdat(out)));
});

// --- Synthetic C2PA store ---
const cborText = (s) => { const b = new TextEncoder().encode(s); return concat([b.length < 24 ? Uint8Array.of(0x60 | b.length) : Uint8Array.of(0x78, b.length), b]); };
const cborMap = (pairs) => concat([Uint8Array.of(0xA0 | pairs.length), ...pairs.flatMap(([k, v]) => [cborText(k), v])]);
const cborArray = (items) => concat([Uint8Array.of(0x80 | items.length), ...items]);
const box = (type, ...payload) => { const body = concat(payload); const out = new Uint8Array(8 + body.length); putU32(out, 0, out.length); out.set(ascii(type), 4); out.set(body, 8); return out; };
const jumb = (label, ...kids) => box('jumb', box('jumd', new Uint8Array(16), Uint8Array.of(0x03), ascii(`${label}\0`)), ...kids);
function c2paStore(sourceType, generator) {
  const actions = cborMap([['actions', cborArray([cborMap([
    ['action', cborText('c2pa.created')],
    ...(sourceType ? [['digitalSourceType', cborText(`http://cv.iptc.org/newscodes/digitalsourcetype/${sourceType}`)]] : []),
    ['softwareAgent', cborMap([['name', cborText('GPT-4o')]])],
  ])])]]);
  const claim = cborMap([['claim_generator_info', cborArray([cborMap([['name', cborText(generator)]])])]]);
  return jumb('c2pa', jumb('urn:c2pa:1', jumb('c2pa.assertions', jumb('c2pa.actions.v2', box('cbor', actions))), jumb('c2pa.claim.v2', box('cbor', claim))));
}
function pngWith(store) {
  const png = fx('ai.png');
  const chunk = new Uint8Array(12 + store.length);
  putU32(chunk, 0, store.length); chunk.set(ascii('caBX'), 4); chunk.set(store, 8);
  putU32(chunk, 8 + store.length, crc32(chunk, 4, 8 + store.length));
  return concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

test('C2PA: AI labels from the manifest', async () => {
  const created = pngWith(c2paStore('trainedAlgorithmicMedia', 'ChatGPT'));
  assert.deepEqual(readC2pa(created, 'PNG'), { parsed: true, generator: 'ChatGPT', sourceTypes: ['trainedAlgorithmicMedia'], aiAgents: ['GPT-4o'] });
  const report = await analyze(cleanImage(fx('plain.jpg'), 'JPEG'), 'a.jpg');
  assert.equal(readC2pa(fx('plain.jpg'), 'JPEG'), null);
  assert.ok(kinds(report).includes('NO_AI_TRACES'));

  const signal = (c2pa) => evaluateSignals({ c2pa, hasAnyMetadata: true });
  assert.deepEqual(signal(readC2pa(created, 'PNG'))[0], { severity: 'AI_EVIDENCE', kind: 'C2PA_AI_CREATED', args: ['GPT-4o'] });
  const edited = readC2pa(pngWith(c2paStore('compositeWithTrainedAlgorithmicMedia', 'Adobe Photoshop')), 'PNG');
  assert.equal(signal(edited)[0].kind, 'C2PA_AI_EDITED');
  const plain = readC2pa(pngWith(c2paStore(null, 'Adobe Photoshop 25')), 'PNG');
  assert.deepEqual(signal(plain).map((s) => s.kind), ['C2PA_PRESENT', 'NO_AI_TRACES']);
  const byGenerator = readC2pa(pngWith(c2paStore(null, 'ChatGPT')), 'PNG');
  assert.deepEqual(signal(byGenerator).map((s) => s.kind), ['AI_TOOL_FIELD', 'C2PA_PRESENT']);
  assert.equal(await (async () => hasAiEvidence(await analyze(cleanImage(created, 'PNG'), 'a.png')))(), false, 'cleaning removes caBX');
});

test('signals: markers, context and file names', () => {
  assert.equal(toolMarker('Midjourney v6'), 'midjourney');
  assert.equal(toolMarker('Aurora HDR 2019'), null);
  assert.equal(toolMarker('Google Gemini image generator'), 'gemini');
  assert.equal(toolMarker('DOSBox emulator'), null);
  assert.equal(copySource('IMG-20240101-WA0007.jpg'), 'WhatsApp');
  assert.equal(copySource('Снимок экрана 2024-01-01.png'), 'screenshot');
  assert.equal(copySource('DSC_0001.JPG'), null);
  const mention = evaluateSignals({ freeTextFields: [{ label: 'EXIF ImageDescription', value: 'Fireflies, made with Firefly' }], hasAnyMetadata: true });
  assert.deepEqual(mention.map((s) => s.kind), ['AI_MENTION_TEXT', 'NO_AI_TRACES']);
  const report = { file: { truncated: false }, signals: mention };
  assert.ok(needsAiReview(report));
  const a1111 = evaluateSignals({ freeTextFields: [{ label: 'EXIF UserComment', value: 'cat\nSteps: 30, Sampler: DPM++, Seed: 5' }], hasAnyMetadata: true, fileName: 'IMG-20240101-WA0007.jpg' });
  assert.deepEqual(a1111.map((s) => s.kind), ['GENERATION_PARAMS']);
  const iptc = evaluateSignals({ xmpFields: { 'Iptc4xmpExt:DigitalSourceType': 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia' }, hasAnyMetadata: true });
  assert.equal(iptc[0].kind, 'IPTC_AI_SOURCE');
});

test('XMP: bounded linear parsing', () => {
  const packet = '<x:xmpmeta><rdf:Description xmp:CreatorTool = "A &amp; B" stEvt:softwareAgent="One"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Hello</rdf:li></rdf:Alt></dc:title><stEvt:softwareAgent>Two</stEvt:softwareAgent><dc:titleX>no</dc:titleX></rdf:Description></x:xmpmeta>';
  const xmp = parseXmp(packet);
  assert.equal(xmp.fields['xmp:CreatorTool'], 'A & B');
  assert.equal(xmp.fields['dc:title'], 'Hello');
  assert.equal(xmp.fields['stEvt:softwareAgent'], 'One, Two');
  const started = Date.now();
  assert.deepEqual(valuesOf('<dc:title '.repeat(60000), 'dc:title'), []);
  assert.ok(Date.now() - started < 2000);
});

test('license keys: ECDSA P-256 signature', async () => {
  globalThis.crypto ??= webcrypto;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const make = (payload) => {
    const body = `MC1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${body}.${createSign('SHA256').update(body).sign(privateKey).toString('base64url')}`;
  };
  assert.deepEqual(await verifyLicense(make({ id: 'tester-1', note: 'beta' }), pub), { id: 'tester-1', expiresAt: null, note: 'beta' });
  await assert.rejects(verifyLicense(make({ id: 'old', exp: 1000 }), pub), { code: 'EXPIRED' });
  await assert.rejects(verifyLicense(make({ id: 'x' }).replace('MC1.', 'MC1.e'), pub), (e) => ['BAD_SIGNATURE', 'MALFORMED'].includes(e.code));
  await assert.rejects(verifyLicense('nonsense', pub), { code: 'MALFORMED' });
  await assert.rejects(verifyLicense(make({ id: 'x' })), { code: 'BAD_SIGNATURE' }, 'a key signed by someone else is refused by the built-in public key');
  await assert.rejects(verifyLicense(make({ id: 'x' }), ''), { code: 'NOT_ENABLED' });
});

test('zip and formats', async () => {
  const taken = new Set();
  assert.deepEqual(['a.jpg', 'a.jpg', 'a.jpg'].map((n) => uniqueName(n, taken)), ['a.jpg', 'a (2).jpg', 'a (3).jpg']);
  const blob = zipBlob([{ name: 'фото.jpg', bytes: fx('plain.jpg') }, { name: 'b.txt', bytes: ascii('hello') }]);
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034B50);
  assert.equal(bytes.readUInt16LE(bytes.length - 22 + 10), 2);
  assert.equal(detectFormat(fx('gps_sample.heic')), 'HEIC');
  assert.equal(detectFormat(ascii('hello world, not an image')), 'UNKNOWN');
  await assert.rejects(analyzeFile(new File([ascii('hello world, not an image')], 'a.txt')), /UNSUPPORTED_FORMAT/);
});

test('damaged input never throws out of the analysis', async () => {
  for (const name of ['photo.jpg', 'ai.png', 'photo.webp', 'anim.gif', 'gps_sample.heic', 'clip.mp4']) {
    const source = fx(name);
    for (const cut of [40, 200, Math.floor(source.length / 2)]) {
      try { await analyze(source.subarray(0, cut), name); } catch (e) { assert.match(String(e), /UNSUPPORTED_FORMAT/); }
    }
    const noisy = source.slice();
    for (let i = 20; i < noisy.length; i += 37) noisy[i] ^= 0x5A;
    try { await analyze(noisy, name); } catch (e) { assert.match(String(e), /UNSUPPORTED_FORMAT/); }
  }
});

test('video: udta with a QuickTime zero terminator is still read', async () => {
  const source = fx('clip.mp4');
  const buf = Buffer.from(source);
  const moov = buf.indexOf('moov') - 4;
  const udta = buf.indexOf('udta', moov) - 4;
  assert.equal(udta + buf.readUInt32BE(udta), buf.length, 'fixture: udta is the last box of the file');
  const out = Buffer.concat([buf, Buffer.alloc(4)]);
  out.writeUInt32BE(buf.readUInt32BE(moov) + 4, moov);
  out.writeUInt32BE(buf.readUInt32BE(udta) + 4, udta);
  const { report } = await analyzeFile(new File([out], 'clip.mp4'));
  assert.ok(report.gps, 'location inside udta');
  assert.equal(field(report, 'video:title'), 'Holiday clip');
});

test('malformed files give format errors, and text chunks are scanned inside their bounds', async () => {
  const heic = fx('gps_sample.heic');
  for (const cut of [600, 5000, 200000]) {
    assert.throws(() => cleanImage(heic.subarray(0, cut), 'HEIC'), (e) => e.name === 'Error' && typeof e.code === 'string');
    assert.throws(() => wipeGps(heic.subarray(0, cut), 'HEIC'), (e) => typeof e.code === 'string');
  }
  for (const [name, format] of [['photo.jpg', 'JPEG'], ['ai.png', 'PNG'], ['photo.webp', 'WEBP'], ['anim.gif', 'GIF'], ['gps_sample.heic', 'HEIC']]) {
    const noisy = fx(name).slice();
    for (let i = 12; i < Math.min(noisy.length, 4000); i += 23) noisy[i] ^= 0xA5;
    for (const op of [() => cleanImage(noisy, format), () => wipeGps(noisy, format)]) {
      try { op(); } catch (e) { assert.equal(typeof e.code, 'string', `${name}: ${e}`); }
    }
  }
  // A tEXt chunk without a zero byte must not be read as text, even when zeros follow in later chunks.
  const chunk = (type, data) => { const c = new Uint8Array(12 + data.length); putU32(c, 0, data.length); c.set(ascii(type), 4); c.set(data, 8); putU32(c, 8 + data.length, crc32(c, 4, 8 + data.length)); return c; };
  const png = fx('ai.png');
  const bad = concat([png.subarray(0, 33), chunk('tEXt', ascii('no-terminator-here')), png.subarray(33)]);
  const report = await analyze(bad, 'bad.png');
  assert.deepEqual(report.pngTextItems.map((i) => i.label), ['parameters', 'Software']);
});

test('little-endian EXIF with a thumbnail: read, edit, GPS removal, cleaning', async () => {
  const { emptyTiff, serializeTiff, asciiEntry, shortEntry, rationalEntry, byteEntry, parseTiff } = await import('../js/core/tiff.js');
  const { sanitizeJpeg, jpegExif } = await import('../js/core/jpeg.js');
  const t = emptyTiff();
  t.little = true;
  t.ifd0.set(0x010F, asciiEntry('LittleCam'));
  t.ifd0.set(0x0112, shortEntry(8, true));
  t.exif = new Map([[0x9003, asciiEntry('2023:12:31 23:30:00')], [0x8827, shortEntry(640, true)], [0x829A, rationalEntry([[1, 60]], true)]]);
  t.gps = new Map([[0, byteEntry([2, 3, 0, 0])], [1, asciiEntry('S')], [2, rationalEntry([[33, 1], [51, 1], [2448, 100]], true)],
    [3, asciiEntry('E')], [4, rationalEntry([[151, 1], [12, 1], [5508, 100]], true)]]);
  t.ifd1 = new Map([[0x0103, shortEntry(6, true)]]);
  t.thumbnail = fx('plain.jpg');
  const source = sanitizeJpeg(fx('plain.jpg'), serializeTiff(t));

  const report = await analyze(source, 'le.jpg');
  assert.equal(field(report, 'exif:Make'), 'LittleCam');
  assert.equal(field(report, 'exif:PhotographicSensitivity'), '640');
  assert.ok(Math.abs(report.gps.latitude + 33.8568) < 1e-4 && Math.abs(report.gps.longitude - 151.2153) < 1e-4);
  assert.ok(inspectJpeg(source).exifThumbnail);

  const edited = applyPatch(source, { model: 'M2', iso: 100000, exposureSeconds: 2.5 });
  assert.ok(edited.verified);
  const after = parseTiff(jpegExif(edited.bytes));
  assert.ok(after.little, 'byte order is kept');
  assert.deepEqual([...after.thumbnail], [...fx('plain.jpg')], 'thumbnail survives the rewrite');
  const editedReport = await analyze(edited.bytes, 'le.jpg');
  assert.equal(field(editedReport, 'exif:Make'), 'LittleCam');
  assert.equal(field(editedReport, 'exif:PhotographicSensitivity'), '100000');
  assert.ok(editedReport.gps, 'GPS is untouched when the patch does not mention it');

  const shifted = shiftJpegDates(source, 3600);
  assert.equal(field(await analyze(shifted.bytes, 'le.jpg'), 'exif:DateTimeOriginal'), '2024:01:01 00:30:00');

  const noGps = wipeGps(source, 'JPEG');
  const noGpsReport = await analyze(noGps.bytes, 'le.jpg');
  assert.equal(noGpsReport.gps, null);
  assert.equal(field(noGpsReport, 'exif:Make'), 'LittleCam');

  const clean = cleanImage(source, 'JPEG');
  assert.ok(isStrippedJpeg(clean));
  assert.equal(inspectJpeg(clean).exifThumbnail, false);
  assert.equal(readExif(clean, 'JPEG').orientation, 8);
});
