import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeProjectDirName,
  shortProjectName,
  aggregateSession,
} from '../lib/sessions.js';

const NOW = Date.now();
const isoNow = () => new Date(NOW).toISOString();
const isoAgo = (ms) => new Date(NOW - ms).toISOString();
const statsAgo = (ms) => ({ size: 1024, mtimeMs: NOW - ms });

function makeAssistant({ ts = isoNow(), tools = [], usage = {}, model = 'claude-opus-4-7' } = {}) {
  return {
    type: 'assistant',
    timestamp: ts,
    cwd: 'C:\\Users\\test\\my-project',
    message: {
      role: 'assistant',
      model,
      content: tools.map((t, i) => ({
        type: 'tool_use',
        id: t.id ?? `t${i}`,
        name: t.name,
        input: t.input ?? {},
      })),
      usage,
    },
  };
}

function makeUserText(text, ts = isoNow()) {
  return {
    type: 'user',
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}

function makeToolResult(toolUseId, ts = isoNow()) {
  return {
    type: 'user',
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'result' }],
    },
  };
}

test('decodeProjectDirName: Windows path with drive letter', () => {
  assert.equal(
    decodeProjectDirName('c--Users-Egils-Varna-Projects'),
    'C:\\Users\\Egils\\Varna\\Projects',
  );
});

test('decodeProjectDirName: Windows path uppercase drive letter', () => {
  assert.equal(
    decodeProjectDirName('C--Users-Egils-Varna'),
    'C:\\Users\\Egils\\Varna',
  );
});

test('decodeProjectDirName: Unix-style fallback', () => {
  assert.equal(decodeProjectDirName('home-egils-projects'), 'home/egils/projects');
});

test('shortProjectName: extracts last segment of Windows path', () => {
  assert.equal(shortProjectName('C:\\Users\\Egils\\Projects\\my-app'), 'my-app');
});

test('shortProjectName: extracts last segment of Unix path', () => {
  assert.equal(shortProjectName('/home/egils/projects/my-app'), 'my-app');
});

test('shortProjectName: null returns "unknown"', () => {
  assert.equal(shortProjectName(null), 'unknown');
});

test('shortProjectName: empty string returns "unknown"', () => {
  assert.equal(shortProjectName(''), 'unknown');
});

test('aggregateSession: returns null for empty entries', () => {
  assert.equal(aggregateSession('sid', [], statsAgo(0)), null);
});

test('aggregateSession: tokens summed across multiple assistant messages', () => {
  const entries = [
    makeAssistant({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
      },
    }),
    makeAssistant({
      usage: { input_tokens: 200, output_tokens: 80 },
    }),
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.tokens.input, 300);
  assert.equal(s.tokens.output, 130);
  assert.equal(s.tokens.cacheRead, 1000);
  assert.equal(s.tokens.cacheCreate, 500);
  assert.equal(s.tokens.total, 1930);
});

test('aggregateSession: toolUsage histogram and toolCount', () => {
  const entries = [
    makeAssistant({ tools: [{ name: 'Edit' }, { name: 'Read' }] }),
    makeAssistant({ tools: [{ name: 'Edit' }] }),
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.toolUsage.Edit, 2);
  assert.equal(s.toolUsage.Read, 1);
  assert.equal(s.toolCount, 3);
});

test('aggregateSession: status="active" when last activity < 30s ago', () => {
  const entries = [makeAssistant({ ts: isoAgo(5_000) })];
  const s = aggregateSession('sid', entries, statsAgo(5_000));
  assert.equal(s.status, 'active');
});

test('aggregateSession: status="waiting" when tool_use unanswered and 30s-5min old', () => {
  const ts = isoAgo(60_000);
  const entries = [makeAssistant({ ts, tools: [{ id: 't1', name: 'Bash' }] })];
  const s = aggregateSession('sid', entries, statsAgo(60_000));
  assert.equal(s.status, 'waiting');
});

test('aggregateSession: status="recent" when tool_use answered and 30s-5min old', () => {
  const ts = isoAgo(60_000);
  const entries = [
    makeAssistant({ ts, tools: [{ id: 't1', name: 'Bash' }] }),
    makeToolResult('t1', ts),
  ];
  const s = aggregateSession('sid', entries, statsAgo(60_000));
  assert.equal(s.status, 'recent');
});

test('aggregateSession: status="idle" when last activity > 5min ago', () => {
  const entries = [makeAssistant({ ts: isoAgo(60 * 60_000) })];
  const s = aggregateSession('sid', entries, statsAgo(60 * 60_000));
  assert.equal(s.status, 'idle');
});

test('FIX: userMessageCount only counts text-bearing user messages, not tool_result wrappers', () => {
  const entries = [
    makeUserText('hello'),
    makeAssistant({ tools: [{ id: 't1', name: 'Bash' }] }),
    makeToolResult('t1'),
    makeUserText('thanks'),
    makeAssistant({ tools: [{ id: 't2', name: 'Read' }] }),
    makeToolResult('t2'),
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.userMessageCount, 2, 'should count 2 real user messages, not 4');
});

test('FIX: tool_result-only user messages contribute zero to userMessageCount', () => {
  const entries = [
    makeAssistant({ tools: [{ id: 't1', name: 'Read' }] }),
    makeToolResult('t1'),
    makeToolResult('t2'),
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.userMessageCount, 0);
  assert.equal(s.assistantMessageCount, 1);
});

test('FIX: currentTool is null when status is "idle"', () => {
  const entries = [
    makeAssistant({ ts: isoAgo(60 * 60_000), tools: [{ name: 'Edit' }] }),
  ];
  const s = aggregateSession('sid', entries, statsAgo(60 * 60_000));
  assert.equal(s.status, 'idle');
  assert.equal(s.currentTool, null, 'currentTool should be cleared for idle sessions');
});

test('FIX: currentTool is null when status is "recent"', () => {
  const ts = isoAgo(60_000);
  const entries = [
    makeAssistant({ ts, tools: [{ id: 't1', name: 'Edit' }] }),
    makeToolResult('t1', ts),
  ];
  const s = aggregateSession('sid', entries, statsAgo(60_000));
  assert.equal(s.status, 'recent');
  assert.equal(s.currentTool, null, 'currentTool should be cleared once session is no longer live');
});

test('aggregateSession: currentTool preserved for "active" status', () => {
  const entries = [makeAssistant({ tools: [{ name: 'Edit' }] })];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.status, 'active');
  assert.equal(s.currentTool, 'Edit');
});

test('aggregateSession: currentTool preserved for "waiting" status', () => {
  const ts = isoAgo(60_000);
  const entries = [makeAssistant({ ts, tools: [{ id: 't1', name: 'Bash' }] })];
  const s = aggregateSession('sid', entries, statsAgo(60_000));
  assert.equal(s.status, 'waiting');
  assert.equal(s.currentTool, 'Bash');
});
