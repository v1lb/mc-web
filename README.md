# MetaCheck Web

Russian version: [README.ru.md](README.ru.md).

The web version of [MetaCheck](https://github.com/v1lb/metacheck): shows what a photo or video reveals (EXIF, GPS, XMP, IPTC,
PNG text chunks, Content Credentials / C2PA, MP4/MOV tags), looks for traces of AI generation in the metadata and saves copies
with the metadata removed or edited. Everything runs in the browser: files are never uploaded.

A static site with no build step and no dependencies: plain ES modules, served as is by GitHub Pages.

## Features
- Check a file by drag and drop, file dialog or paste from the clipboard: JPEG, PNG, WebP, GIF, HEIC, AVIF, MP4, MOV.
- AI signs from metadata only: C2PA manifest (read, signature not verified), IPTC DigitalSourceType, generation parameters
  (A1111, ComfyUI, NovelAI, Fooocus, InvokeAI), about 70 generator names.
- Privacy index (0–100) with the actual values, GPS shield, metadata viewer with search and CSV export, schematic offline map;
  OpenStreetMap tiles load only after pressing the button.
- Cleaning without recompression: JPEG, PNG, WebP, GIF, HEIC/AVIF (in place), MP4/MOV (Pro). Every result is verified.
- GPS-only removal (JPEG, PNG, WebP, HEIC, AVIF), EXIF editor for JPEG, batch cleaning into a ZIP, folder audit,
  batch date shift (Pro).
- Report history and statistics in the browser's local storage; text, print/PDF and JSON export, sending the JSON report to
  your own API (Pro).
- English and Russian, light and dark themes.

Free: up to 10 cleaned photos per day (UTC), 5 per batch, 10 reports in history. Pro is activated with a license key
(`MC1.…`), the same keys as in the Android app (`tools/license_tool.py` there).

## Differences from the Android app
- Cleaning never re-encodes pixels (the browser re-encodes only as a fallback for files with an unusual structure).
- No Google Play purchase, no camera, no overwriting of the original file: the browser always downloads a new copy.
- "Save PDF" opens the browser's print dialog.
- The API key is stored in local storage without encryption; the API server must allow CORS requests from the site.

## Structure
```
index.html, css/app.css      page shell and styles
js/core/                     parsers, cleaners, editor, signal rules: no DOM, runs in Node too
js/i18n/                     en.js, ru.js: strings shared with the Android app; web.js: website strings
js/ui/                       views (home, report, studio, settings), maps
js/store.js, js/ops.js       local storage, plan limits, file operations
tests/                       Node tests and fixtures
```

## Development
```
npm test                      # node --test, Node 20+
npm run serve                 # http://localhost:8080
python3 tests/make_fixtures.py   # rebuild fixtures (Pillow, ffmpeg)
```

## Publishing
GitHub → Settings → Pages → Deploy from a branch → `main`, folder `/ (root)`. The site appears at
`https://v1lb.github.io/mc-web/`. Pages for a private repository needs a paid GitHub plan; otherwise make the repository public.

## Licenses
IBM Plex Sans and IBM Plex Mono: SIL Open Font License 1.1, Copyright © 2017 IBM Corp. World outline: Natural Earth (public domain).
Map tiles and data: © OpenStreetMap contributors (ODbL).
