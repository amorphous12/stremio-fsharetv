'use strict';
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fsharetv = require('./fsharetv');

const EXTRA_BASE = [{ name: 'skip' }, { name: 'search' }];
const EXTRA_FULL = [
  { name: 'skip' },
  { name: 'search' },
  { name: 'genre', options: fsharetv.CATEGORIES },
];

const manifest = {
  id: 'community.fsharetv.cc',
  version: '1.0.0',
  name: 'FshareTV',
  description: 'Xem phim từ FshareTV — phim học ngôn ngữ, dual subtitles',
  logo: 'https://fsharetv.cc/favicon.ico',
  catalogs: [
    { id: 'fsharetv-home',    type: 'movie', name: '🆕 FshareTV - Mới Nhất', extra: EXTRA_FULL },
    { id: 'fsharetv-action',  type: 'movie', name: '💥 Action',               extra: EXTRA_BASE },
    { id: 'fsharetv-drama',   type: 'movie', name: '🎭 Drama',                 extra: EXTRA_BASE },
    { id: 'fsharetv-comedy',  type: 'movie', name: '😂 Comedy',                extra: EXTRA_BASE },
    { id: 'fsharetv-horror',  type: 'movie', name: '👻 Horror',                extra: EXTRA_BASE },
    { id: 'fsharetv-romance', type: 'movie', name: '💕 Romance',               extra: EXTRA_BASE },
    { id: 'fsharetv-animation',type:'movie', name: '🎌 Animation',             extra: EXTRA_BASE },
    { id: 'fsharetv-documentary',type:'movie',name:'📹 Documentary',           extra: EXTRA_BASE },
  ],
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['fsharetv:'],
};

const CATALOG_GENRE = {
  'fsharetv-action':      'Action',
  'fsharetv-drama':       'Drama',
  'fsharetv-comedy':      'Comedy',
  'fsharetv-horror':      'Horror',
  'fsharetv-romance':     'Romance',
  'fsharetv-animation':   'Animation',
  'fsharetv-documentary': 'Documentary',
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const page = Math.floor((parseInt(extra.skip) || 0) / 24) + 1;
  let items = [];
  try {
    if (extra.search) {
      items = await fsharetv.search(extra.search);
    } else if (extra.genre) {
      items = await fsharetv.getCategory(extra.genre, page);
    } else if (CATALOG_GENRE[id]) {
      items = await fsharetv.getCategory(CATALOG_GENRE[id], page);
    } else {
      items = await fsharetv.getHome();
    }
    return { metas: items.map(fsharetv.toMeta) };
  } catch(e) {
    console.error('[catalog] error:', e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('fsharetv:')) return { meta: null };
  try {
    const slug = id.replace('fsharetv:', '');
    const data = await fsharetv.getDetail(slug);
    if (!data) return { meta: null };
    return { meta: fsharetv.toMeta(data) };
  } catch(e) { return { meta: null }; }
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (!id.startsWith('fsharetv:')) return { streams: [] };
  try {
    const slug = id.replace('fsharetv:', '');
    const data = await fsharetv.getStream(slug);
    if (!data || !data.streams.length) {
      // Fallback: mở trang gốc
      return { streams: [{
        externalUrl: `https://fsharetv.cc/movie/${slug}`,
        title: '🔗 Mở FshareTV',
      }]};
    }
    const streams = data.streams.map(s => ({
      url: s.url,
      title: `▶ ${s.quality}p`,
      behaviorHints: { notWebReady: false },
    }));
    return { streams };
  } catch(e) {
    console.error('[stream] error:', e.message);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`FshareTV Addon: http://localhost:${PORT}/manifest.json`);