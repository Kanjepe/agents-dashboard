import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCodexSession } from '../lib/codex.js';

function rolloutLines(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

function entry(timestamp, type, payload) {
  return { timestamp, type, payload };
}

test('aggregateCodexSession normalizes identity, messages, usage, and provider', () => {
  const now = Date.now();
  const t1 = new Date(now - 30_000).toISOString();
  const t2 = new Date(now - 20_000).toISOString();
  const content = rolloutLines([
    entry(t1, 'session_meta', {
      id: 'codex-session-1',
      cwd: 'C:\\Users\\Test\\Projects\\codex-live',
    }),
    entry(t1, 'turn_context', { model: 'gpt-5.6-sol' }),
    entry(t1, 'event_msg', { type: 'user_message', message: 'Add Codex live sessions' }),
    entry(t2, 'event_msg', {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 1200,
          cached_input_tokens: 200,
          output_tokens: 100,
          total_tokens: 1300,
        },
      },
    }),
    entry(t2, 'event_msg', { type: 'agent_message', message: 'Working on it.' }),
  ]);

  const session = aggregateCodexSession(
    'fallback-id',
    content,
    { mtimeMs: now, size: content.length },
    now,
  );

  assert.equal(session.provider, 'codex');
  assert.equal(session.sessionId, 'codex-session-1');
  assert.equal(session.projectName, 'codex-live');
  assert.equal(session.projectPath, 'C:\\Users\\Test\\Projects\\codex-live');
  assert.equal(session.model, 'gpt-5.6-sol');
  assert.equal(session.status, 'live');
  assert.equal(session.userMessageCount, 1);
  assert.equal(session.assistantMessageCount, 1);
  assert.equal(session.tokens.input, 1000);
  assert.equal(session.tokens.cacheRead, 200);
  assert.equal(session.tokens.output, 100);
  assert.equal(session.tokens.total, 1300);
  assert.match(session.title, /Add Codex live sessions/);
});

test('aggregateCodexSession exposes pending Codex actions and normalized detail', () => {
  const now = Date.now();
  const started = new Date(now - 10_000).toISOString();
  const content = rolloutLines([
    entry(started, 'session_meta', {
      session_id: 'codex-session-2',
      cwd: 'C:\\work\\telemetry',
    }),
    entry(started, 'response_item', {
      type: 'custom_tool_call',
      call_id: 'call-1',
      name: 'exec',
      input: "const result = await tools.shell_command({ command: 'rg live' });",
    }),
  ]);

  const session = aggregateCodexSession(
    'fallback-id',
    content,
    { mtimeMs: now, size: content.length },
    now,
  );

  assert.equal(session.currentTool, 'exec');
  assert.equal(session.currentToolDetail, 'shell_command');
  assert.equal(session.toolCount, 1);
  assert.deepEqual(session.toolUsage, { exec: 1 });
  assert.deepEqual(session.toolHistory, [{ t: started, name: 'exec' }]);
});

test('aggregateCodexSession clears completed action and marks stale work paused', () => {
  const now = Date.now();
  const started = new Date(now - 5 * 60_000).toISOString();
  const finished = new Date(now - 4 * 60_000).toISOString();
  const content = rolloutLines([
    entry(started, 'session_meta', { session_id: 'codex-session-3', cwd: 'C:\\work' }),
    entry(started, 'response_item', {
      type: 'function_call',
      call_id: 'call-1',
      name: 'read_file',
      arguments: '{}',
    }),
    entry(finished, 'response_item', {
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'ok',
    }),
  ]);

  const session = aggregateCodexSession(
    'fallback-id',
    content,
    { mtimeMs: now, size: content.length },
    now,
  );

  assert.equal(session.status, 'paused');
  assert.equal(session.currentTool, null);
  assert.equal(session.currentToolDetail, null);
  assert.equal(session.toolCount, 1);
});
