/* Wraps assets/sample-squad.csv into a plain <script> file.
   Run after changing the sample CSV:  node tools/make-sample-js.mjs

   Why this exists
   ---------------
   Browsers refuse fetch()/XHR from a file:// page — the page's origin is
   opaque, so reading a sibling file counts as a cross-origin request. That
   made "Load sample data" fail for anyone who did the obvious thing and
   double-clicked index.html.

   A classic <script> tag is NOT subject to that rule: file:// pages may load
   file:// scripts. So the same CSV is also shipped as a script that assigns
   the text to a global, and the app injects it on demand. Works identically
   from disk and from a web address, with no server and no fetch.          */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SRC = resolve(ROOT, 'assets/sample-squad.csv');
const OUT = resolve(ROOT, 'assets/sample-squad.js');

const csv = readFileSync(SRC, 'utf8');

// JSON.stringify gives a correctly escaped JS string literal — quotes,
// backslashes and newlines all handled. The </script> guard matters because
// that sequence inside a string literal would still close the tag in HTML.
const literal = JSON.stringify(csv).replace(/<\/script/gi, '<\\/script');

const banner = `/* GENERATED FILE — do not edit.
   Source: assets/sample-squad.csv
   Regenerate: node tools/make-sample-js.mjs

   This is the demo dataset, shipped as a script so it loads from a file://
   page where fetch() is blocked. */\n`;

writeFileSync(OUT, `${banner}window.__SWIMTRACKER_SAMPLE__ = ${literal};\n`, 'utf8');

const rows = csv.trim().split('\n').length - 1;
console.log(`assets/sample-squad.js: ${rows} rows, ${(literal.length / 1024).toFixed(0)} KB`);
