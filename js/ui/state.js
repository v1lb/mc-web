// Shared state of the page and the few actions every view needs. app.js fills in the actions at startup.

export const state = {
  /** The file being inspected: { file (null for a saved report), report, exif, previewUrl, historyId }. */
  current: null,
  /** Files queued in the studio's batch tab; survives navigation between views. */
  batchFiles: [],
  studioTab: 'strip',
  reportTab: 'analysis',
  busy: false,
};

export const actions = {
  navigate: (_hash) => {},
  render: () => {},
  toast: (_text, _kind) => {},
  confirm: async (_options) => false,
  openPro: () => {},
  checkFile: async (_file, _target) => {},
  openReport: (_report, _extra) => {},
  /** Runs an async operation with the busy flag and shows its error as a toast. Returns its result or null. */
  run: async (_fn) => null,
};

export const VERSION = '2.11.0';
