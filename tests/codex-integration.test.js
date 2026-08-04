import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const appSource = readFileSync(join(rootDir, 'public', 'app.js'), 'utf8');
const serverSource = readFileSync(join(rootDir, 'server.js'), 'utf8');

test('provider tabs are excluded from chart range tab behavior', () => {
  assert.match(
    appSource,
    /const chartTabs = document\.querySelectorAll\('\.chart-tabs:not\(\.provider-tabs\) \.chart-tab'\);/,
  );
});

test('server watches Codex rollouts and invalidates Codex stats on changes', () => {
  assert.match(
    serverSource,
    /import \{ aggregateCodexStats, getCodexSessionsDir, invalidateCodexStatsCache \} from '\.\/lib\/codex\.js';/,
  );
  assert.match(serverSource, /const codexWatcher = chokidar\.watch\(/);
  assert.match(serverSource, /codexWatcher\.on\('add', onCodexJsonlChange\);/);
  assert.match(serverSource, /codexWatcher\.on\('change', onCodexJsonlChange\);/);
  assert.match(serverSource, /invalidateCodexStatsCache\(\);/);
  assert.match(serverSource, /codexWatcher\.close\(\);/);
});

test('Codex aggregation failures cannot prevent Claude snapshots', () => {
  assert.match(
    serverSource,
    /aggregateCodexStats\(\)\.catch\(\(err\) => \{[\s\S]*?return null;[\s\S]*?\}\),/,
  );
});
