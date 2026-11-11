// 检查更新与下载更新包。
//
// 网络这块有个现实：用户环境里 github.com 经常连不上，但 api.github.com
// 与 release-assets.githubusercontent.com 是通的。所以这里**只走 API**：
//   1. GET /repos/<repo>/releases/latest 拿版本号、更新说明和各资产（含 sha256 digest）
//   2. 下载走资产的 api url（带 Accept: application/octet-stream，会 302 到 CDN）
// 全程不碰 github.com 网页直链，也不用我们额外维护清单文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { bad, notFound } from './util.mjs';

const REPO = process.env.WB_UPDATE_REPO || 'Sorenzc/Soren-todo-Workbench';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_MS = 6 * 60 * 60 * 1000; // 六小时内不重复打 GitHub
const FETCH_TIMEOUT = 8000;

// 下载状态放模块级：同一时间只允许一个下载任务
const state = {
  phase: 'idle', // idle | running | done | error
  asset: null,
  received: 0,
  total: 0,
  file: null,
  digest: null,
  digestOk: null,
  error: null,
  started_at: null,
  finished_at: null,
};

export function downloadState() {
  const total = state.total || 0;
  const received = state.received || 0;
  return {
    ...state,
    percent: total ? (received >= total ? 100 : Math.min(99, Math.floor((received / total) * 100))) : 0,
    received_mb: Math.round((received / 1048576) * 10) / 10,
    total_mb: Math.round((total / 1048576) * 10) / 10,
  };
}

export function parseVersion(text) {
  const m = String(text || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return va[i] > vb[i] ? 1 : -1;
  }
  return 0;
}

/** 挑「适合本机」的安装包：优先安装版，其次单文件版，最后便携 zip。 */
function pickAsset(assets) {
  const order = [/setup\.exe$/i, /^todo-workbench\.exe$/i, /portable\.zip$/i];
  for (const re of order) {
    const hit = assets.find((a) => re.test(a.name));
    if (hit) return hit;
  }
  return null;
}

async function fetchLatest() {
  const res = await fetch(API, {
    headers: {
      'user-agent': 'todo-workbench-updater',
      accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`GitHub 接口返回 ${res.status}`);
  const body = await res.json();
  if (!body || !body.tag_name) throw new Error('GitHub 返回的版本信息不完整');
  const assets = (body.assets || []).map((a) => ({
    name: a.name,
    size: a.size,
    digest: a.digest || null,
    url: a.url,
    browser_url: a.browser_download_url,
    download_count: a.download_count,
  }));
  return {
    tag: body.tag_name,
    version: String(body.tag_name).replace(/^v/i, ''),
    title: body.name || body.tag_name,
    notes: body.body || '',
    published_at: body.published_at,
    page_url: body.html_url,
    assets,
  };
}

/**
 * 检查是否有新版本。带 6 小时缓存，force=true 时强制刷新。
 * 联网失败不抛错，返回 ok:false + error，让界面自己决定怎么提示。
 */
export async function checkUpdate(db, { current, force = false } = {}) {
  const cacheKey = 'update_cache';
  let cache = null;
  try {
    const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(cacheKey);
    if (row && row.value) cache = JSON.parse(row.value);
  } catch {
    cache = null;
  }
  const fresh = cache && cache.at && Date.now() - cache.at < CACHE_MS;
  if (fresh && !force && cache.data) {
    return shape(cache.data, current, { cached: true, checked_at: cache.at });
  }

  try {
    const latest = await fetchLatest();
    db.prepare(
      `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(cacheKey, JSON.stringify({ at: Date.now(), data: latest }), new Date().toISOString());
    return shape(latest, current, { cached: false, checked_at: Date.now() });
  } catch (err) {
    // 有旧缓存就先把旧的给出去，同时把错误带上
    if (cache && cache.data) {
      return shape(cache.data, current, {
        cached: true,
        checked_at: cache.at,
        error: `检查更新失败：${err.message}`,
      });
    }
    return {
      ok: false,
      current,
      latest: null,
      has_update: false,
      cached: false,
      checked_at: null,
      error: `检查更新失败：${err.message}`,
      notes: '',
      page_url: `https://github.com/${REPO}/releases`,
      assets: [],
    };
  }
}

function shape(latest, current, meta) {
  const pick = pickAsset(latest.assets || []);
  return {
    ok: !meta.error,
    current,
    latest: latest.version,
    title: latest.title,
    has_update: compareVersions(latest.version, current) > 0,
    notes: latest.notes,
    published_at: latest.published_at,
    page_url: latest.page_url || `https://github.com/${REPO}/releases`,
    assets: (latest.assets || []).map((a) => ({
      name: a.name,
      size: a.size,
      size_mb: Math.round((a.size / 1048576) * 10) / 10,
      digest: a.digest,
    })),
    suggested: pick
      ? { name: pick.name, size: pick.size, size_mb: Math.round((pick.size / 1048576) * 10) / 10, digest: pick.digest }
      : null,
    cached: Boolean(meta.cached),
    checked_at: meta.checked_at,
    error: meta.error || null,
  };
}

/**
 * 下载更新包到 updates 目录，边下边算 sha256。
 * 返回时任务已在后台跑，进度用 downloadState() 查。
 */
export async function startDownload(db, current, dataDir, assetName) {
  if (state.phase === 'running') throw bad('已经有一个下载任务在跑了', 'UPDATE_BUSY');

  const info = await checkUpdate(db, { current, force: false });
  const target = assetName || info.suggested?.name;
  if (!target) throw bad('这个版本没有可下载的安装包', 'UPDATE_NO_ASSET');

  const assets = await assetsFor(db, current);
  const asset = assets.find((a) => a.name === target);
  if (!asset) throw notFound('没有找到这个安装包');

  const dir = path.join(dataDir, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);

  state.phase = 'running';
  state.asset = asset.name;
  state.received = 0;
  state.total = asset.size || 0;
  state.file = file;
  state.digest = asset.digest || null;
  state.digestOk = null;
  state.error = null;
  state.started_at = new Date().toISOString();
  state.finished_at = null;

  runDownload(asset, file).catch((err) => {
    state.phase = 'error';
    state.error = err.message;
    state.finished_at = new Date().toISOString();
  });

  return downloadState();
}

async function assetsFor(db, current) {
  const info = await checkUpdate(db, { current, force: false });
  // checkUpdate 只回形状化的资产，这里需要 url，从缓存里取原始数据
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get('update_cache');
  if (!row || !row.value) return [];
  try {
    return JSON.parse(row.value).data.assets || [];
  } catch {
    return [];
  }
}

async function runDownload(asset, file) {
  const res = await fetch(asset.url, {
    headers: { accept: 'application/octet-stream', 'user-agent': 'todo-workbench-updater' },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || asset.size || 0);
  if (total) state.total = total;

  const hash = crypto.createHash('sha256');
  const tmp = file + '.part';
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      state.received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    await new Promise((r) => out.end(r));
    reader.cancel().catch(() => {});
  }

  const got = 'sha256:' + hash.digest('hex');
  state.digestOk = asset.digest ? got === asset.digest : null;
  if (state.digestOk === false) {
    fs.rmSync(tmp, { force: true });
    throw new Error('sha256 校验不通过，文件可能不完整，请重试');
  }
  fs.renameSync(tmp, file);
  state.phase = 'done';
  state.finished_at = new Date().toISOString();
}
