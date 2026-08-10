'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const listCache = new NodeCache({ stdTTL: 600 });
const detailCache = new NodeCache({ stdTTL: 300 });

const BASE = 'https://fsharetv.cc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Cookie jar — giữ session giữa các request (quan trọng để bypass anti-bot)
const jar = new CookieJar();
const client = wrapper(axios.create({
  jar,
  withCredentials: true,
  timeout: 20000,
  headers: {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive',
  },
}));

let warmedUp = false;

async function warmUp() {
  if (warmedUp) return;
  try {
    await client.get(BASE + '/', {
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    warmedUp = true;
  } catch(e) {
    console.error('[FshareTV] warmup error:', e.message);
  }
}

async function fetchHtml(url, referer) {
  try {
    const res = await client.get(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': referer || BASE + '/',
      }
    });
    return res.data;
  } catch(e) {
    console.error('[FshareTV] fetchHtml error:', url, e.message);
    return null;
  }
}

async function fetchJson(url, referer) {
  try {
    const res = await client.get(url, {
      headers: {
        'Accept': 'application/json, */*;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': referer || BASE + '/',
      }
    });
    return res.data;
  } catch(e) {
    console.error('[FshareTV] fetchJson error:', url, e.message);
    return null;
  }
}

// Parse danh sách phim từ HTML
function parseMovieGrid(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // Pattern 1: movie-item div
  $('.movie-item, .film-item, article.item').each((i, el) => {
    const $el = $(el);
    const a = $el.find('a[href*="/movie/"], a[href*="/w/"]').first();
    const href = a.attr('href') || '';
    const slug = href.replace(/^.*\/(movie|w)\/([^\/\?]+).*$/, '$2');
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const title = $el.find('b, .title, h3, h2').first().text().trim()
      || a.attr('title') || slug;
    const thumb = $el.find('img').first().attr('src')
      || $el.find('img').first().attr('data-src') || '';
    if (slug && slug !== href) {
      items.push({ slug, title: title.replace(/\s+/g, ' ').trim(), thumb: absUrl(thumb), href });
    }
  });

  // Pattern 2: fallback — tìm link /movie/
  if (!items.length) {
    $('a[href*="/movie/"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const slug = href.replace(/^.*\/movie\/([^\/\?]+).*$/, '$1');
      if (!slug || slug === href || seen.has(slug)) return;
      seen.add(slug);
      const title = $(el).find('b').text().trim() || $(el).attr('title') || slug;
      const thumb = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || '';
      items.push({ slug, title: title.replace(/\s+/g, ' ').trim(), thumb: absUrl(thumb), href });
    });
  }

  return items;
}

function absUrl(path) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  if (path.startsWith('//')) return 'https:' + path;
  return BASE + '/' + path.replace(/^\//, '');
}

// Danh sách phim mới
async function getHome() {
  const key = 'home';
  const c = listCache.get(key); if (c) return c;
  await warmUp();
  const html = await fetchHtml(BASE + '/');
  const r = parseMovieGrid(html);
  listCache.set(key, r); return r;
}

// Theo thể loại
async function getCategory(name, page = 1) {
  const key = `cat_${name}_${page}`;
  const c = listCache.get(key); if (c) return c;
  await warmUp();
  let url = `${BASE}/category/${encodeURIComponent(name)}`;
  if (page > 1) url += `?page=${page}`;
  const html = await fetchHtml(url);
  const r = parseMovieGrid(html);
  listCache.set(key, r); return r;
}

// Tìm kiếm
async function search(keyword) {
  const key = `search_${keyword}`;
  const c = listCache.get(key); if (c) return c;
  await warmUp();
  // Thử nhiều endpoint search
  const urls = [
    `${BASE}/search?q=${encodeURIComponent(keyword)}`,
    `${BASE}/search/${encodeURIComponent(keyword)}`,
    `${BASE}/?s=${encodeURIComponent(keyword)}`,
  ];
  let r = [];
  for (const url of urls) {
    const html = await fetchHtml(url);
    r = parseMovieGrid(html);
    if (r.length) break;
  }
  listCache.set(key, r); return r;
}

// Sort sources theo chất lượng
function sortSources(sources) {
  const order = { '1080': 0, '720': 1, '480': 2, '360': 3 };
  return [...sources].sort((a, b) => {
    const qa = order[a.quality] ?? 99;
    const qb = order[b.quality] ?? 99;
    return qa - qb;
  });
}

// Gọi API lấy stream sources
async function resolveViaApi(fileId, watchUrl) {
  const apiUrl = `${BASE}/api/file/${fileId}/source?trailer=null&type=watch`;
  try {
    const data = await fetchJson(apiUrl, watchUrl);
    if (!data) return [];
    const sources = data?.data?.file?.sources || [];
    if (!sources.length) return [];
    const sorted = sortSources(sources.map(s => ({
      quality: s.quality || s.label || 'SD',
      url: absUrl(s.src),
      storage: s.storage || '',
    })));
    // Lọc bỏ nguồn __backup
    return sorted.filter(s => s.storage !== '__backup');
  } catch(e) {
    console.error('[FshareTV] resolveViaApi error:', e.message);
    return [];
  }
}

// Lấy stream từ trang phim
async function getStream(slug) {
  const cached = detailCache.get(`stream_${slug}`);
  if (cached) return cached;

  await warmUp();
  const movieUrl = `${BASE}/movie/${slug}`;
  const html = await fetchHtml(movieUrl);
  if (!html) return null;

  const $ = cheerio.load(html);

  // Tìm watch link /w/
  let watchHtml = html;
  let watchUrl = movieUrl;
  const watchLink = $('a[href*="/w/"]').first().attr('href');
  if (watchLink) {
    watchUrl = absUrl(watchLink);
    const wh = await fetchHtml(watchUrl, movieUrl);
    if (wh) watchHtml = wh;
  }

  const $w = cheerio.load(watchHtml);
  let streams = [];

  // Path A: <video src>
  const videoSrc = $w('video').attr('src') || $w('video source').attr('src');
  if (videoSrc) {
    streams = [{ quality: 'Default', url: absUrl(videoSrc) }];
  }

  // Path B: Movie.setSource(file_id)
  if (!streams.length) {
    const msMatch = watchHtml.match(/Movie\.setSource\s*\(\s*['"]([^'"]+)['"]/);
    if (msMatch) {
      const fileId = msMatch[1].replace(/@/g, '+');
      streams = await resolveViaApi(fileId, watchUrl);
    }
  }

  // Path C: data-episode attribute
  if (!streams.length) {
    const dsMatch = watchHtml.match(/data-episode\s*=\s*['"]([^'"]{20,})['"]/);
    if (dsMatch) {
      const fileId = dsMatch[1].replace(/@/g, '+');
      streams = await resolveViaApi(fileId, watchUrl);
    }
  }

  // Path D: subtitle input value
  if (!streams.length) {
    const stMatch = watchHtml.match(/input[^>]+value\s*=\s*['"]([A-Za-z0-9+\/=@]{30,})['"]/);
    if (stMatch) {
      const fileId = stMatch[1].replace(/@/g, '+');
      streams = await resolveViaApi(fileId, watchUrl);
    }
  }

  // Path E: /api/file/ URL trong JS
  if (!streams.length) {
    const apiMatch = watchHtml.match(/\/api\/file\/([^\/'"]+)\/source/);
    if (apiMatch) {
      streams = await resolveViaApi(apiMatch[1], watchUrl);
    }
  }

  // Parse meta
  const title = $w('h1, .movie-title, title').first().text().trim()
    .replace(/\s*[-|]\s*FshareTV.*$/i, '').trim();
  const thumb = $w('meta[property="og:image"]').attr('content')
    || $w('.movie-poster img, .film-poster img').first().attr('src') || '';

  const result = { title, thumb: absUrl(thumb), streams, watchUrl };
  if (streams.length) detailCache.set(`stream_${slug}`, result);
  return result;
}

// Chi tiết phim cho meta handler
async function getDetail(slug) {
  const key = `detail_${slug}`;
  const c = listCache.get(key); if (c) return c;
  await warmUp();
  const html = await fetchHtml(`${BASE}/movie/${slug}`);
  if (!html) return null;
  const $ = cheerio.load(html);
  const title = $('h1, .movie-title').first().text().trim()
    .replace(/\s*[-|]\s*FshareTV.*$/i, '').trim();
  const thumb = $('meta[property="og:image"]').attr('content')
    || $('.movie-poster img').first().attr('src') || '';
  const desc = $('meta[property="og:description"]').attr('content')
    || $('.movie-desc, .description').first().text().trim() || '';
  const year = ($('.year, .release-year').first().text().trim().match(/\d{4}/) || [])[0];
  const genres = [];
  $('a[href*="/category/"]').each((i, el) => {
    const g = $(el).text().trim();
    if (g) genres.push(g);
  });
  const data = { slug, title, thumb: absUrl(thumb), desc, year, genres };
  listCache.set(key, data);
  return data;
}

function toMeta(item) {
  return {
    id: `fsharetv:${item.slug}`,
    type: 'movie',
    name: item.title || item.slug,
    poster: item.thumb || '',
    background: item.thumb || '',
    description: item.desc || '',
    year: item.year ? parseInt(item.year) : undefined,
    genres: item.genres || [],
  };
}

const CATEGORIES = [
  'Action','Adventure','Animation','Comedy','Crime','Documentary',
  'Drama','Family','History','Horror','Music','Mystery',
  'Romance','Science Fiction','Thriller','War','Western',
];

module.exports = { getHome, getCategory, search, getStream, getDetail, toMeta, CATEGORIES };