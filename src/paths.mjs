// 路径安全：校验用户提供的本地文件夹路径，并安全地交给 explorer
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './util.mjs';

const MAX_LEN = 240;

/** 校验并规范化一个用户关联路径。不存在也允许（记录"还没建/盘没插"的意图）。 */
export function validateUserPath(raw, kind = 'folder') {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError(400, 'INVALID_PATH', '路径不能为空');
  }
  let s = raw.trim();
  if (s.includes('\u0000') || /[\u0000-\u001f]/.test(s)) {
    throw new ApiError(400, 'INVALID_PATH', '路径包含非法控制字符');
  }
  // 去引号（用户常从资源管理器复制带引号的路径）
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.length > MAX_LEN) throw new ApiError(400, 'INVALID_PATH', '路径过长（上限 240 字符）');
  // 设备前缀 / 长路径前缀：绕过 Win32 校验的入口
  if (/^\\\\[.?]\\/.test(s)) throw new ApiError(400, 'INVALID_PATH', '不允许设备或长路径前缀');
  if (!path.isAbsolute(s)) throw new ApiError(400, 'INVALID_PATH', '请填写绝对路径，例如 E:\\我的文档\\合同');
  if (s.includes('..')) {
    const normalized = path.normalize(s);
    if (normalized.split(/[\\/]/).includes('..')) {
      throw new ApiError(400, 'INVALID_PATH', '路径不得包含 ..');
    }
    s = normalized;
  }
  s = path.normalize(s);
  if (s.length > 3) s = s.replace(/[\\/]+$/, '');

  let existsState = 'unknown';
  let isDir = false;
  let real = s;
  try {
    real = fs.realpathSync.native(s);
    const st = fs.statSync(real);
    isDir = st.isDirectory();
    existsState = 'ok';
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      existsState = 'missing';
    } else if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      existsState = 'denied';
    } else {
      existsState = 'missing';
    }
  }

  if (existsState === 'ok') {
    if (kind === 'folder' && !isDir) {
      throw new ApiError(422, 'PATH_KIND_MISMATCH', '该路径是文件，不是文件夹', { path: real });
    }
    if (kind === 'file' && isDir) {
      throw new ApiError(422, 'PATH_KIND_MISMATCH', '该路径是文件夹，不是文件', { path: real });
    }
  }

  return {
    path: existsState === 'ok' ? real : s,
    inputPath: s,
    kind,
    existsState,
    label: path.basename(existsState === 'ok' ? real : s) || s,
  };
}

/** 打开路径前的复检（纵深防御：DB 可能被第三方改脏） */
export function assertOpenable(rawPath, kind) {
  if (typeof rawPath !== 'string' || !rawPath) {
    throw new ApiError(422, 'PATH_MISSING', '路径为空');
  }
  if (rawPath.length > MAX_LEN) throw new ApiError(400, 'INVALID_PATH', '路径过长');
  if (rawPath.includes('\u0000')) throw new ApiError(400, 'INVALID_PATH', '路径包含非法字符');
  if (/^\\\\[.?]\\/.test(rawPath)) throw new ApiError(400, 'INVALID_PATH', '不允许设备前缀');
  if (!path.isAbsolute(rawPath)) throw new ApiError(400, 'INVALID_PATH', '必须是绝对路径');
  if (kind !== 'folder' && kind !== 'file') throw new ApiError(400, 'INVALID_PATH', '未知的关联类型');

  let real;
  try {
    real = fs.realpathSync.native(rawPath);
  } catch (err) {
    const code = err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'PATH_MISSING' : 'PATH_DENIED';
    throw new ApiError(422, code, code === 'PATH_MISSING' ? '路径不存在' : '无访问权限', { path: rawPath });
  }
  let st;
  try {
    st = fs.statSync(real);
  } catch {
    throw new ApiError(422, 'PATH_DENIED', '无访问权限', { path: rawPath });
  }
  if (kind === 'folder' && !st.isDirectory()) {
    throw new ApiError(422, 'PATH_KIND_MISMATCH', '关联类型与路径不符（应为文件夹）', { path: real });
  }
  if (kind === 'file' && !st.isFile()) {
    throw new ApiError(422, 'PATH_KIND_MISMATCH', '关联类型与路径不符（应为文件）', { path: real });
  }
  return real;
}

/** 组装 explorer 参数（永远用数组 + shell:false，绝不拼命令行字符串） */
export function explorerArgs(realPath, kind) {
  if (kind === 'file') {
    // /select, 的逗号是语法的一部分：路径本身含逗号时退化为打开父目录
    if (realPath.includes(',')) return [path.dirname(realPath)];
    return [`/select,${realPath}`];
  }
  return [realPath];
}
