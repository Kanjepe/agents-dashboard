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
    decodeProjectDirName('c--Users-test-Projects'),
    'C:\\Users\\test\\Projects',
  );
});

test('decodeProjectDirName: Windows path uppercase drive letter', () => {
  assert.equal(
    decodeProjectDirName('C--Users-test'),
    'C:\\Users\\test',
  );
});

test('decodeProjectDirName: Unix-style fallback', () => {
  assert.equal(decodeProjectDirName('home-test-projects'), 'home/test/projects');
});

test('shortProjectName: extracts last segment of Windows path', () => {
  assert.equal(shortProjectName('C:\\Users\\test\\Projects\\my-app'), 'my-app');
});

test('shortProjectName: extracts last segment of Unix path', () => {
  assert.equal(shortProjectName('/home/test/projects/my-app'), 'my-app');
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

test('aggregateSession identifies Claude as the session provider', () => {
  const s = aggregateSession('provider-test', [makeAssistant()], { size: 1, mtimeMs: Date.now() });
  assert.equal(s.provider, 'claude');
});

test('aggregateSession: status="live" when last activity < 2 min ago', () => {
  const entries = [makeAssistant({ ts: isoAgo(30_000) })];
  const s = aggregateSession('sid', entries, statsAgo(30_000));
  assert.equal(s.status, 'live');
});

test('aggregateSession: status="waiting" when tool_use unanswered within 30 min', () => {
  const ts = isoAgo(5 * 60_000);
  const entries = [makeAssistant({ ts, tools: [{ id: 't1', name: 'Bash' }] })];
  const s = aggregateSession('sid', entries, statsAgo(5 * 60_000));
  assert.equal(s.status, 'waiting');
});

test('aggregateSession: status="paused" when answered and 2-30 min old', () => {
  const ts = isoAgo(10 * 60_000);
  const entries = [
    makeAssistant({ ts, tools: [{ id: 't1', name: 'Bash' }] }),
    makeToolResult('t1', ts),
  ];
  const s = aggregateSession('sid', entries, statsAgo(10 * 60_000));
  assert.equal(s.status, 'paused');
});

test('aggregateSession: status="idle" when last activity > 30 min ago', () => {
  const entries = [makeAssistant({ ts: isoAgo(60 * 60_000) })];
  const s = aggregateSession('sid', entries, statsAgo(60 * 60_000));
  assert.equal(s.status, 'idle');
});

test('aggregateSession: fresh session with pending tool_use is "live", not "waiting"', () => {
  const entries = [makeAssistant({ ts: isoAgo(30_000), tools: [{ id: 't1', name: 'Edit' }] })];
  const s = aggregateSession('sid', entries, statsAgo(30_000));
  assert.equal(s.status, 'live', 'fresh tool_use is auto-executing, not awaiting user');
  assert.equal(s.currentTool, 'Edit');
});

test('userMessageCount only counts text-bearing user messages, not tool_result wrappers', () => {
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

test('tool_result-only user messages contribute zero to userMessageCount', () => {
  const entries = [
    makeAssistant({ tools: [{ id: 't1', name: 'Read' }] }),
    makeToolResult('t1'),
    makeToolResult('t2'),
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.userMessageCount, 0);
  assert.equal(s.assistantMessageCount, 1);
});

test('userMessageCount: mixed content (text + tool_result in same message) counts once', () => {
  const entries = [
    makeAssistant({ tools: [{ id: 't1', name: 'Read' }] }),
    {
      type: 'user',
      timestamp: isoNow(),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'text', text: 'and what about Y?' },
        ],
      },
    },
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.userMessageCount, 1);
});

test('userMessageCount: plain-string content counts as one message', () => {
  const entries = [
    {
      type: 'user',
      timestamp: isoNow(),
      message: { role: 'user', content: 'hi from a string' },
    },
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.userMessageCount, 1);
});

test('userMessageCount: empty-string content does not count', () => {
  const entries = [
    {
      type: 'user',
      timestamp: isoNow(),
      message: { role: 'user', content: '' },
    },
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.userMessageCount, 0);
});

test('currentTool is null when status is "idle"', () => {
  const entries = [
    makeAssistant({ ts: isoAgo(60 * 60_000), tools: [{ name: 'Edit' }] }),
  ];
  const s = aggregateSession('sid', entries, statsAgo(60 * 60_000));
  assert.equal(s.status, 'idle');
  assert.equal(s.currentTool, null, 'currentTool should be cleared for idle sessions');
});

test('currentTool is null when status is "paused"', () => {
  const ts = isoAgo(10 * 60_000);
  const entries = [
    makeAssistant({ ts, tools: [{ id: 't1', name: 'Edit' }] }),
    makeToolResult('t1', ts),
  ];
  const s = aggregateSession('sid', entries, statsAgo(10 * 60_000));
  assert.equal(s.status, 'paused');
  assert.equal(s.currentTool, null, 'currentTool should be cleared for paused sessions');
});

test('currentTool preserved for "live" status', () => {
  const entries = [makeAssistant({ tools: [{ name: 'Edit' }] })];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.status, 'live');
  assert.equal(s.currentTool, 'Edit');
});

test('currentTool preserved for "waiting" status', () => {
  const ts = isoAgo(5 * 60_000);
  const entries = [makeAssistant({ ts, tools: [{ id: 't1', name: 'Bash' }] })];
  const s = aggregateSession('sid', entries, statsAgo(5 * 60_000));
  assert.equal(s.status, 'waiting');
  assert.equal(s.currentTool, 'Bash');
});

test('subagents: extracts Task tool_use with subagent_type', () => {
  const entries = [
    makeAssistant({
      tools: [
        {
          id: 't1',
          name: 'Task',
          input: { subagent_type: 'gsd-planner', description: 'Plan phase X' },
        },
      ],
    }),
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].type, 'gsd-planner');
  assert.equal(s.subagents[0].description, 'Plan phase X');
  assert.equal(s.subagents[0].completed, false);
  assert.equal(s.currentTool, 'Task');
  assert.equal(s.currentToolDetail, 'gsd-planner');
});

test('subagents: marked completed when tool_result matches', () => {
  const ts1 = isoAgo(20_000);
  const ts2 = isoAgo(5_000);
  const entries = [
    makeAssistant({ ts: ts1, tools: [{ id: 't1', name: 'Task', input: { subagent_type: 'reviewer' } }] }),
    makeToolResult('t1', ts2),
  ];
  const s = aggregateSession('sid', entries, statsAgo(5_000));
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].completed, true);
  assert.ok(s.subagents[0].durationMs >= 14_000 && s.subagents[0].durationMs <= 16_000);
});

test('skills: extracts Skill tool_use with skill name', () => {
  const entries = [
    makeAssistant({
      tools: [{ id: 't1', name: 'Skill', input: { skill: 'twino-skill-manager' } }],
    }),
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.skills.length, 1);
  assert.equal(s.skills[0].name, 'twino-skill-manager');
  assert.equal(s.currentToolDetail, 'twino-skill-manager');
});

test('subagents and skills both collected in one session', () => {
  const entries = [
    makeAssistant({ tools: [{ id: 't1', name: 'Task', input: { subagent_type: 'gsd-planner' } }] }),
    makeAssistant({ tools: [{ id: 't2', name: 'Skill', input: { skill: '/review' } }] }),
    makeAssistant({ tools: [{ id: 't3', name: 'Task', input: { subagent_type: 'code-reviewer' } }] }),
  ];
  const s = aggregateSession('sid', entries, statsAgo(0));
  assert.equal(s.subagents.length, 2);
  assert.equal(s.skills.length, 1);
  assert.deepEqual(
    s.subagents.map((x) => x.type),
    ['gsd-planner', 'code-reviewer'],
  );
});

test('currentToolDetail null for paused/idle status', () => {
  const ts = isoAgo(10 * 60_000);
  const entries = [
    makeAssistant({ ts, tools: [{ id: 't1', name: 'Task', input: { subagent_type: 'gsd-planner' } }] }),
    makeToolResult('t1', ts),
  ];
  const s = aggregateSession('sid', entries, statsAgo(10 * 60_000));
  assert.equal(s.status, 'paused');
  assert.equal(s.currentTool, null);
  assert.equal(s.currentToolDetail, null);
});
