import fs from 'node:fs';
const js = fs.readFileSync('E:/SFH office/workbench/public/app.js', 'utf8');
const html = fs.readFileSync('E:/SFH office/workbench/public/index.html', 'utf8');
const used = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));
const defined = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
console.log('js 里引用了但 html 没有的 id:', [...used].filter((x) => !defined.has(x)));
console.log('html 有但 js 没用的 id:', [...defined].filter((x) => !used.has(x)));

// 函数引用审计：找到所有 xxx( 形式的调用，检查是否定义或内建
const defs = new Set([
  ...[...js.matchAll(/function\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]),
  ...[...js.matchAll(/const\s+([A-Za-z0-9_$]+)\s*=/g)].map((m) => m[1]),
  ...[...js.matchAll(/(?:let|var)\s+([A-Za-z0-9_$]+)\s*=/g)].map((m) => m[1]),
  ...[...js.matchAll(/import\s+\{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())),
]);
const builtin = new Set(['fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'URLSearchParams', 'URL', 'Blob', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'JSON', 'Math', 'Promise', 'Error', 'RegExp', 'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'console', 'localStorage', 'document', 'window', 'btoa', 'atob']);
const called = [...js.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
const unknown = [...new Set(called)].filter((n) => !defs.has(n) && !builtin.has(n) && !/^(if|for|while|switch|catch|return|typeof|new|function|await|async|else|do|try)$/.test(n));
console.log('可能未定义的调用:', unknown);
