// 通用工具：时间、日期、slug、错误
import { randomUUID } from 'node:crypto';

export const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间带偏移的 ISO：2026-10-19T11:40:00+08:00 */
export function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad2(Math.floor(Math.abs(off) / 60));
  const om = pad2(Math.abs(off) % 60);
  return `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
    d.getSeconds()
  )}${sign}${oh}:${om}`;
}

export function parseLocalDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 给 YYYY-MM-DD 加天数，返回同样的格式 */
export function addDays(dateStr, n) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

/** 日历天数差 b - a（整数） */
export function diffDays(a, b) {
  const da = Date.UTC(...isoParts(a));
  const db = Date.UTC(...isoParts(b));
  return Math.round((db - da) / 86400000);
}

function isoParts(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return [y, (m || 1) - 1, d || 1];
}

/** 从带偏移的 ISO 字符串取日期部分 */
export function dateOf(iso) {
  return iso ? String(iso).slice(0, 10) : null;
}

/** 从带偏移的 ISO 字符串取年月 YYYY-MM */
export function monthOf(iso) {
  return iso ? String(iso).slice(0, 7) : null;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 安全文件名 slug：保留中日韩字符，去掉 Windows 非法字符 */
export function slugify(input, max = 60) {
  let s = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .trim();
  if (!s) s = 'task';
  if (WIN_RESERVED.test(s)) s = `t-${s}`;
  if (s.length > max) s = s.slice(0, max).replace(/[-._]+$/, '');
  return s;
}

export const uid = () => randomUUID();

export function shortId(id, n = 8) {
  return String(id).replace(/-/g, '').slice(0, n);
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const bad = (msg, code = 'BAD_REQUEST', details) => new ApiError(400, code, msg, details);
export const notFound = (msg = '资源不存在', code = 'NOT_FOUND') => new ApiError(404, code, msg);
export const conflict = (msg, details) => new ApiError(409, 'REV_CONFLICT', msg, details);

export function asInt(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function clampStr(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

export const PRIORITY_NAMES = ['P0 紧急', 'P1 重要', 'P2 普通', 'P3 可缓'];
export const PRIORITY_SHORT = ['P0', 'P1', 'P2', 'P3'];

/** 把 snake_case 键统一成 camelCase：前端/脚本两种写法后端都收 */
export function camelize(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj || {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = /_[a-z]/.test(k) ? k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) : k;
    out[key] = v;
  }
  return out;
}
