import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const files = ['index.html', 'manifest.webmanifest', 'sw.js'];
const dirs = ['assets', 'icons'];
const changelogPath = path.join(root, 'changelog.json');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date) {
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : String(date);
}

function changelogHtml(entries) {
  const normalized = entries.map((entry, index) => ({
    date: String(entry.date || ''),
    legacyNumber: Number.isFinite(Number(entry.number)) ? Number(entry.number) : null,
    title: String(entry.title || ''),
    body: String(entry.body || ''),
    sourceIndex: index,
  }));

  normalized.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    if (byDate) return byDate;

    const aHasNumber = a.legacyNumber !== null;
    const bHasNumber = b.legacyNumber !== null;
    if (aHasNumber && bHasNumber && a.legacyNumber !== b.legacyNumber) {
      return a.legacyNumber - b.legacyNumber;
    }
    if (aHasNumber !== bHasNumber) return aHasNumber ? -1 : 1;
    return a.sourceIndex - b.sourceIndex;
  });

  const groups = [];
  for (const entry of normalized) {
    const last = groups[groups.length - 1];
    if (!last || last.date !== entry.date) groups.push({ date: entry.date, entries: [entry] });
    else last.entries.push(entry);
  }

  return groups.map(group => `
            <section class="changelog-day" data-date="${escapeHtml(group.date)}">
              <div class="changelog-day-head">${escapeHtml(formatDate(group.date))}</div>
              <div class="changelog-day-list">
${group.entries.map((entry, index) => `                <article class="changelog-item">
                  <h3><span class="changelog-index">${index + 1}.</span>${escapeHtml(entry.title)}</h3>
                  <p>${escapeHtml(entry.body)}</p>
                </article>`).join('\n')}
              </div>
            </section>`).join('');
}

function injectChangelog(indexHtml, entries) {
  const markerPattern = /<div\b[^>]*\bid="islandChangelog"[^>]*data-changelog-source="changelog\.json"[^>]*>\s*<\/div>/;
  const markerPatternReversed = /<div\b[^>]*\bdata-changelog-source="changelog\.json"[^>]*\bid="islandChangelog"[^>]*>\s*<\/div>/;
  const html = `<div class="changelog" id="islandChangelog" data-changelog-source="changelog.json">${changelogHtml(entries)}\n          </div>`;
  if (markerPattern.test(indexHtml)) return indexHtml.replace(markerPattern, html);
  if (markerPatternReversed.test(indexHtml)) return indexHtml.replace(markerPatternReversed, html);
  throw new Error('index.html 中找不到更新日志构建占位符');
}

const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
if (!Array.isArray(changelog)) throw new Error('changelog.json 必须是数组');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const file of files) {
  let content = fs.readFileSync(path.join(root, file), 'utf8');
  if (file === 'index.html') content = injectChangelog(content, changelog);
  fs.writeFileSync(path.join(dist, file), content);
}
for (const dir of dirs) {
  if (!fs.existsSync(path.join(root, dir))) continue;
  fs.cpSync(path.join(root, dir), path.join(dist, dir), { recursive: true });
}

fs.copyFileSync(changelogPath, path.join(dist, 'changelog.json'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(dist, 'release.json'), JSON.stringify({
  version: String(packageJson.version || ''),
  builtAt: new Date().toISOString(),
  changelogEntries: changelog.length
}, null, 2) + '\n');

console.log(`Build complete: ${path.relative(root, dist)}`);
console.log('Changelog entries:', changelog.length);
console.log('Entry:', path.join('dist', 'index.html'));
console.log('Changelog:', path.join('dist', 'changelog.json'));
