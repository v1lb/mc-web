// Rules that look for traces of AI generation in metadata. No traces proves nothing: metadata is easy to remove.
//
// Sources, most reliable first:
//  1. C2PA and IPTC DigitalSourceType: labels the generators add themselves (ChatGPT, Gemini, Firefly…).
//  2. Generation parameters (prompt, steps, sampler) written by local generators (A1111, ComfyUI…).
//  3. A generator name in software fields (Software, CreatorTool).
//  4. A generator mentioned in free text: a caution only.

import { TRAINED, COMPOSITE_TRAINED } from './c2pa.js';
import { KEY_DIGITAL_SOURCE_TYPE } from './xmp.js';

export const C2PA_UNREADABLE = 'unreadable';
const SEVERITY_ORDER = { AI_EVIDENCE: 0, CAUTION: 1, INFO: 2 };

/** Specific enough not to match ordinary software ("flux.1", not "flux"). */
export const AI_MARKERS = [
  'midjourney', 'dall-e', 'dall·e', 'dalle', 'chatgpt', 'gpt-4o', 'gpt-image', 'openai', 'sora',
  'stable diffusion', 'stablediffusion', 'sdxl', 'dreamstudio', 'stability.ai', 'stability ai',
  'comfyui', 'automatic1111', 'invokeai', 'fooocus', 'forge', 'draw things', 'diffusionbee',
  'novelai', 'niji', 'firefly', 'leonardo.ai', 'ideogram', 'flux.1', 'flux1', 'black forest labs',
  'gemini', 'imagen', 'nano banana', 'grok', 'aurora', 'bing image creator', 'image creator from designer',
  'microsoft designer', 'copilot', 'meta ai', 'imagine with meta', 'emu', 'kling', 'hailuo', 'minimax',
  'recraft', 'playground ai', 'playgroundai', 'nightcafe', 'krea', 'seedream', 'dreamina', 'jimeng',
  'hunyuan', 'qwen-image', 'kandinsky', 'shedevrum', 'civitai', 'tensor.art', 'pixai', 'craiyon',
  'starryai', 'wombo', 'runwayml', 'artbreeder', 'lexica', 'mage.space', 'getimg.ai', 'tusiart',
];

/** Too common in ordinary captions: "Gemini" the zodiac sign, "Aurora" the northern lights. */
const AMBIGUOUS_IN_TEXT = new Set(['sora', 'forge', 'niji', 'gemini', 'imagen', 'grok', 'aurora', 'copilot', 'emu', 'krea',
  'kling', 'minimax', 'lexica', 'wombo', 'jimeng']);
/** Ordinary apps use these names too; a nearby word must point at a generator. */
const NEEDS_CONTEXT_IN_TOOL = new Set(['forge', 'aurora', 'emu', 'copilot', 'imagen', 'gemini']);
const AI_CONTEXT = ['diffusion', 'webui', 'xai', 'google', 'deepmind', 'image generator', 'imagine', 'generat', ' ai', 'ai ', '(ai', 'ai)'];
const INVOKE_KEYS = new Set(['invokeai_metadata', 'invokeai_graph', 'sd-metadata']);

const isA1111 = (t) => t.includes('Steps:') && (t.includes('Sampler:') || t.includes('Seed:') || t.includes('CFG scale:'));

function isGenerationJson(text) {
  const t = text.trimStart();
  if (!t.startsWith('{')) return false;
  const lower = t.toLowerCase();
  return lower.includes('"steps"') && ['"sampler"', '"seed"', '"cfg"', '"scale"', '"cfg_scale"', '"guidance"'].some((k) => lower.includes(k));
}

const isLetter = (c) => c !== undefined && /\p{L}/u.test(c);
const isLetterOrDigit = (c) => c !== undefined && /[\p{L}\p{Nd}]/u.test(c);

/** Whole-word match: "emu" must not be found in "emulator". */
function containsWord(text, marker) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at < 0) return false;
    if (!isLetterOrDigit(text[at - 1]) && !isLetter(text[at + marker.length])) return true;
    from = at + 1;
  }
}

export function toolMarker(text) {
  const lower = text.toLowerCase();
  return AI_MARKERS.find((m) => containsWord(lower, m) && (!NEEDS_CONTEXT_IN_TOOL.has(m) || AI_CONTEXT.some((c) => lower.includes(c)))) ?? null;
}

function textMarker(text) {
  const lower = text.toLowerCase();
  return AI_MARKERS.find((m) => !AMBIGUOUS_IN_TEXT.has(m) && containsWord(lower, m)) ?? null;
}

const SCREENSHOT = 'screenshot';
const COPY_PATTERNS = [
  [/^IMG-\d{8}-WA\d+/i, 'WhatsApp'],
  [/^WhatsApp Image \d{4}-\d{2}-\d{2}/i, 'WhatsApp'],
  [/^photo_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/i, 'Telegram'],
  [/^FB_IMG_\d+/i, 'Facebook'],
  [/^\d+_\d+_\d+_[no]\.(jpe?g|webp)$/i, 'Facebook / Instagram'],
  [/^viber_image_\d{4}/i, 'Viber'],
  [/^signal-\d{4}-\d{2}-\d{2}/i, 'Signal'],
  [/^(Screenshot|Screen ?Shot|Screen_Recording|Capture d.écran|Schermata|Bildschirmfoto|Снимок экрана|Скриншот)/i, SCREENSHOT],
];

export const copySource = (fileName) => COPY_PATTERNS.find(([re]) => re.test(fileName.trim()))?.[1] ?? null;

const dedupeKey = (s) => (s.kind === 'AI_TOOL_FIELD' || s.kind === 'AI_MENTION_TEXT' ? `${s.kind}:${s.args[0]}` : s.kind);

/**
 * input: { toolFields, freeTextFields, xmpFields, pngText, c2pa, hasGps, hasAnyMetadata, truncated, fileName }.
 * Returns [{ severity, kind, args }], most serious first. Texts are resolved by the interface.
 */
export function evaluateSignals(input) {
  const out = [];
  const add = (severity, kind, args = []) => out.push({ severity, kind, args });
  const { toolFields = [], freeTextFields = [], xmpFields = {}, pngText = [], c2pa = null } = input;

  if (c2pa) {
    const generator = c2pa.aiAgents[0] ?? c2pa.generator ?? '';
    const has = (type) => c2pa.sourceTypes.some((t) => t.toLowerCase() === type.toLowerCase());
    if (has(TRAINED)) add('AI_EVIDENCE', 'C2PA_AI_CREATED', [generator]);
    else if (has(COMPOSITE_TRAINED)) add('AI_EVIDENCE', 'C2PA_AI_EDITED', [generator]);
    else {
      add('INFO', 'C2PA_PRESENT', c2pa.parsed ? [c2pa.generator ?? ''] : ['', C2PA_UNREADABLE]);
      // A manifest without an AI label, but written by a generator (older ChatGPT versions).
      const marker = c2pa.generator && toolMarker(c2pa.generator);
      if (marker) add('AI_EVIDENCE', 'AI_TOOL_FIELD', [marker, 'C2PA claim_generator', c2pa.generator.slice(0, 120)]);
    }
  }

  const sourceType = xmpFields[KEY_DIGITAL_SOURCE_TYPE];
  const sourceTail = sourceType?.slice(sourceType.lastIndexOf('/') + 1).trim().toLowerCase();
  if (sourceTail === TRAINED.toLowerCase()) add('AI_EVIDENCE', 'IPTC_AI_SOURCE', [sourceType]);
  else if (sourceTail === COMPOSITE_TRAINED.toLowerCase()) add('AI_EVIDENCE', 'IPTC_AI_EDITED', [sourceType]);

  for (const entry of pngText) {
    const key = entry.keyword.toLowerCase();
    const text = entry.text;
    if (key === 'parameters' && isA1111(text)) add('AI_EVIDENCE', 'SD_PARAMETERS');
    else if ((key === 'prompt' && text.includes('"class_type"')) || (key === 'workflow' && text.includes('"nodes"'))) add('AI_EVIDENCE', 'COMFYUI_GRAPH', [entry.keyword]);
    else if (INVOKE_KEYS.has(key)) add('AI_EVIDENCE', 'INVOKEAI_METADATA', [entry.keyword]);
    else if (isA1111(text) || isGenerationJson(text)) add('AI_EVIDENCE', 'GENERATION_PARAMS', [`PNG ${entry.keyword}`]);
  }
  // AUTOMATIC1111 and Forge write the parameters to EXIF UserComment when saving JPEG or WebP.
  for (const f of freeTextFields) if (isA1111(f.value) || isGenerationJson(f.value)) add('AI_EVIDENCE', 'GENERATION_PARAMS', [f.label]);

  const pngTools = pngText.filter((e) => /^(software|source)$/i.test(e.keyword)).map((e) => ({ label: `PNG ${e.keyword}`, value: e.text }));
  for (const f of [...toolFields, ...pngTools]) {
    const marker = toolMarker(f.value);
    if (marker) add('AI_EVIDENCE', 'AI_TOOL_FIELD', [marker, f.label, f.value.slice(0, 120)]);
  }

  // Free text: the word may be a coincidence ("firefly" on a photo of fireflies), so only a caution.
  for (const f of freeTextFields) {
    const marker = textMarker(f.value);
    if (marker) add('CAUTION', 'AI_MENTION_TEXT', [marker, f.label, f.value.slice(0, 120)]);
  }

  const evidence = out.some((s) => s.severity === 'AI_EVIDENCE');
  if (!evidence) {
    const source = copySource(input.fileName ?? '');
    if (source === SCREENSHOT) add('CAUTION', 'SCREENSHOT');
    else if (source) add('CAUTION', 'MESSENGER_COPY', [source]);
  }
  if (input.hasGps) add('CAUTION', 'HAS_GPS');
  if (!input.hasAnyMetadata) add('CAUTION', 'NO_METADATA');
  if (input.truncated) add('INFO', 'PARTIAL_SCAN');
  if (!evidence) add('INFO', 'NO_AI_TRACES');

  const seen = new Set();
  return out
    .filter((s) => { const k = dedupeKey(s); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((s, i) => [s, i])
    .sort((a, b) => SEVERITY_ORDER[a[0].severity] - SEVERITY_ORDER[b[0].severity] || a[1] - b[1])
    .map(([s]) => s);
}
