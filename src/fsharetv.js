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

const jar = new CookieJar();
const client = wrapper(axios.create({
  jar,
  withCredentials: true,
  timeout: 20000,
  headers: {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
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
    console.log('[FshareTV] warm-up OK');
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
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
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

function absUrl(path) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  if (path.startsWith('//')) return 'https:' + path;
  return BASE + '/' + path.replace(/^\//, '');
}

// Parse danh sách phim từ HTML
function parseMovieGrid(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // Ưu tiên link /w/ vì đó là trang chứa stream
  $('a[href*="/w/"], a[href*="/movie/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const slugMatch = href.match(/\/(?:w|movie)\/([^\/\?#]+)/);
    if (!slugMatch) return;
    const slug = slugMatch[1];
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    const title = (
      $(el).find('b, .title, h3, h2').text().trim()
      || $(el).attr('title')
      || slug
    ).replace(/\s+/g, ' ').trim();
    const thumb = $(el).find('img').attr('src')
      || $(el).find('img').attr('data-src') || '';
    if (title && slug) {
      items.push({ slug, title, thumb: absUrl(thumb) });
    }
  });

  // Fallback: tìm movie-item container
  if (!items.length) {
    $('.movie-item, .film-item, article.item').each((i, el) => {
      const $el = $(el);
      const a = $el.find('a').first();
      const href = a.attr('href') || '';
      const slugMatch = href.match(/\/(?:w|movie)\/([^\/\?#]+)/);
      if (!slugMatch) return;
      const slug = slugMatch[1];
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      const title = ($el.find('b, .title, h3').text().trim()
        || a.attr('title') || slug).replace(/\s+/g, ' ').trim();
      const thumb = $el.find('img').attr('src')
        || $el.find('img').attr('data-src') || '';
      items.push({ slug, title, thumb: absUrl(thumb) });
    });
  }

  return items;
}

// Sort sources theo chất lượng cao → thấp
function sortSources(sources) {
  const order = { '1080': 0, '720': 1, '480': 2, '360': 3, 'Default': 4 };
  return [...sources].sort((a, b) => {
    const qa = order[String(a.quality)] ?? 5;
    const qb = order[String(b.quality)] ?? 5;
    return qa - qb;
  });
}

// Gọi API /api/file/<fileId>/source
async function resolveViaApi(fileId, watchUrl) {
  const apiUrl = `${BASE}/api/file/${fileId}/source?trailer=null&type=watch`;
  console.log('[FshareTV] calling API:', apiUrl);
  try {
    const data = await fetchJson(apiUrl, watchUrl);
    if (!data) return [];
    const sources = data?.data?.file?.sources || [];
    if (!sources.length) return [];
    const mapped = sources
      .filter(s => s.src && s.storage !== '__backup')
      .map(s => ({
        quality: s.quality || s.label || 'SD',
        url: absUrl(s.src),
      }));
    return sortSources(mapped);
  } catch(e) {
    console.error('[FshareTV] resolveViaApi error:', e.message);
    return [];
  }
}

// Lấy stream từ slug
async function getStream(slug) {
  const cached = detailCache.get(`stream_${slug}`);
  if (cached) return cached;

  await warmUp();

  // Fetch trang /w/ trực tiếp — đây là trang chứa player
  const watchUrl = `${BASE}/w/${slug}`;
  console.log('[FshareTV] fetching watch page:', watchUrl);
  const html = await fetchHtml(watchUrl);
  if (!html) {
    console.error('[FshareTV] watch page empty for slug:', slug);
    return null;
  }

  console.log('[FshareTV] html length:', html.length);
  console.log('[FshareTV] preview:', html.substring(0, 300));

  const $ = cheerio.load(html);
  let streams = [];

  // Path A: vlcdn.sbs URL trực tiếp trong HTML
  const vlcdnMatches = [...html.matchAll(/https:\/\/vlcdn\.sbs\/media\/[A-Za-z0-9%+/=?&_.-]+/g)];
  if (vlcdnMatches.length) {
    console.log('[FshareTV] Path A: vlcdn URLs found:', vlcdnMatches.length);
    for (const m of vlcdnMatches) {
      const url = m[0].replace(/['")\s].*$/, ''); // strip trailing chars
      if (!streams.find(s => s.url === url)) {
        streams.push({ quality: 'Default', url });
      }
    }
  }

  // Path B: <video src>
  if (!streams.length) {
    const videoSrc = $('video').attr('src') || $('video source').attr('src');
    if (videoSrc) {
      console.log('[FshareTV] Path B: video src:', videoSrc);
      streams.push({ quality: 'Default', url: absUrl(videoSrc) });
    }
  }

  // Path C: Movie.setSource(file_id)
  if (!streams.length) {
    const msMatch = html.match(/Movie\.setSource\s*\(\s*['"]([^'"]+)['"]/);
    if (msMatch) {
      const fileId = msMatch[1].replace(/@/g, '+');
      console.log('[FshareTV] Path C: Movie.setSource fileId:', fileId.substring(0, 50));
      streams = await resolveViaApi(fileId, watchUrl);
    }
  }

  // Path D: data-episode attribute
  if (!streams.length) {
    const dsMatch = html.match(/data-episode\s*=\s*['"]([^'"]{20,})['"]/);
    if (dsMatch) {
      const fileId = dsMatch[1].replace(/@/g, '+');
      console.log('[FshareTV] Path D: data-episode fileId:', fileId.substring(0, 50));
      streams = await resolveViaApi(fileId, watchUrl);
    }
  }

  // Path E: subtitle input value
  if (!streams.length) {
    const stMatch = html.match(/input[^>]+value\s*=\s*['"]([A-Za-z0-9+\/=@]{30,})['"]/);
    if (stMatch) {
      const fileId = stMatch[1].replace(/@/g, '+');
      console.log('[FshareTV] Path E: subtitle input fileId:', fileId.substring(0, 50));
      streams = await resolveViaApi(fileId, watchUrl);
    }
  }

  // Path F: /api/file/ URL trong JS
  if (!streams.length) {
    const apiMatch = html.match(/\/api\/file\/([^\/'")\s]+)\/source/);
    if (apiMatch) {
      console.log('[FshareTV] Path F: api/file fileId:', apiMatch[1].substring(0, 50));
      streams = await resolveViaApi(apiMatch[1], watchUrl);
    }
  }

  // Path G: src trong JS object có vlcdn
  if (!streams.length) {
    const srcMatch = html.match(/['"]src['"]\s*:\s*['"]([^'"]*vlcdn[^'"]*)['"]/);
    if (srcMatch) {
      console.log('[FshareTV] Path G: src in JS object');
      streams.push({ quality: 'Default', url: absUrl(srcMatch[1]) });
    }
  }

  // Path H: fetch trang /movie/ nếu /w/ không có gì
  if (!streams.length) {
    console.log('[FshareTV] Path H: fallback to /movie/ page');
    const movieUrl = `${BASE}/movie/${slug}`;
    const movieHtml = await fetchHtml(movieUrl, watchUrl);
    if (movieHtml) {
      // Tìm link /w/ trong trang /movie/
      const wMatch = movieHtml.match(/href=["']([^"']*\/w\/[^"']+)['"]/);
      if (wMatch) {
        const wUrl = absUrl(wMatch[1]);
        console.log('[FshareTV] Path H: found /w/ link:', wUrl);
        const wHtml = await fetchHtml(wUrl, movieUrl);
        if (wHtml) {
          const vlcdnMs = [...wHtml.matchAll(/https:\/\/vlcdn\.sbs\/media\/[A-Za-z0-9%+/=?&_.-]+/g)];
          for (const m of vlcdnMs) {
            const url = m[0].replace(/['")\s].*$/, '');
            if (!streams.find(s => s.url === url)) {
              streams.push({ quality: 'Default', url });
            }
          }
          // Thử API từ trang /w/ mới
          if (!streams.length) {
            const msM = wHtml.match(/Movie\.setSource\s*\(\s*['"]([^'"]+)['"]/);
            if (msM) streams = await resolveViaApi(msM[1].replace(/@/g, '+'), wUrl);
          }
        }
      }
    }
  }

  console.log('[FshareTV] streams found:', streams.length);

  const title = $('h1, .movie-title, title').first().text().trim()
    .replace(/\s*[-|]\s*FshareTV.*$/i, '').trim();
  const thumb = $('meta[property="og:image"]').attr('content') || '';

  const result = { title, thumb, streams, watchUrl };
  if (streams.length) detailCache.set(`stream_${slug}`, result);
  return result;
}

// Danh sách phim mới (homepage)
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

// Chi tiết phim cho meta handler
async function getDetail(slug) {
  const key = `detail_${slug}`;
  const c = listCache.get(key); if (c) return c;
  await warmUp();
  const html = await fetchHtml(`${BASE}/movie/${slug}`);
  if (!html) return null;
  const $ = cheerio.load(html);
  const title = $('h1, .movie-title').first().text().trim()
    .replace(/\s*[-|]\s*FshareTV.*$/i, '').trim() || slug;
  const thumb = $('meta[property="og:image"]').attr('content')
    || $('.movie-poster img, .film-poster img').first().attr('src') || '';
  const desc = $('meta[property="og:description"]').attr('content')
    || $('.movie-desc, .description').first().text().trim() || '';
  const year = ($('.year, .release-year').first().text().match(/\d{4}/) || [])[0];
  const genres = [];
  $('a[href*="/category/"]').each((i, el) => {
    const g = $(el).text().trim();
    if (g && !genres.includes(g)) genres.push(g);
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

module.exports = {
  getHome, getCategory, search, getStream, getDetail,
  toMeta, CATEGORIES, warmUp, fetchHtml,
};
