#!/usr/bin/env node
// Собирает src/index.html в один самодостаточный HTML-файл:
// подставляет внутрь страницы локальные стили (<link rel="stylesheet" href="...">),
// скрипты (<script src="..."></script>) и встроенные данные
// (<script type="text/plain|application/json" src="..."></script>).
// Внешние ссылки (http/https, например Google Fonts) остаются как есть.
// Зависимостей нет — нужен только Node.js 18+.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const entry = resolve(root, opt('--entry', 'src/index.html'));
const out = resolve(root, opt('--out', 'dist/edulog.html'));
const version = opt('--version', process.env.APP_VERSION || '');
const srcDir = dirname(entry);

const isLocal = (href) => !/^(?:[a-z]+:)?\/\//i.test(href) && !href.startsWith('data:');
const read = (rel) => {
  if (isAbsolute(rel)) throw new Error(`Абсолютный путь не поддерживается: ${rel}`);
  return readFileSync(resolve(srcDir, rel), 'utf8');
};
// Содержимое не должно закрывать тег раньше времени.
const guard = (text, tag, file) => {
  if (new RegExp(`</${tag}`, 'i').test(text)) {
    throw new Error(`${file} содержит "</${tag}" — его нельзя встроить как есть`);
  }
  return text;
};
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]) : null;
};
const withNl = (s) => (s.endsWith('\n') ? s : s + '\n');

let html = readFileSync(entry, 'utf8');

// <link rel="stylesheet" href="local.css">
html = html.replace(/<link\b[^>]*>/gi, (tag) => {
  const href = attr(tag, 'href');
  if (attr(tag, 'rel') !== 'stylesheet' || !href || !isLocal(href)) return tag;
  return `<style>\n${guard(withNl(read(href)), 'style', href)}</style>`;
});

// <script ... src="local"></script>
html = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs) => {
  const src = attr(tag, 'src');
  if (!src || !isLocal(src)) return tag;
  let body = read(src);
  if (/\.json$/i.test(src)) {
    body = JSON.stringify(JSON.parse(body)); // компактно, без пробелов
  } else {
    body = '\n' + withNl(body);
  }
  const rest = attrs.replace(/\s+src\s*=\s*("[^"]*"|'[^']*')/i, '');
  return `<script${rest}>${guard(body, 'script', src)}</script>`;
});

if (version) {
  html = html.replace(/<title>([^<]*)<\/title>/i, (_, t) => `<title>${t}</title>\n<meta name="version" content="${version}">`);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`Собрано: ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} КБ)`);
