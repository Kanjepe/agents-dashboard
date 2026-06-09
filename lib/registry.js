import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

export function isInsideDir(filePath, dir) {
  const resolved = resolve(filePath);
  const root = resolve(dir);
  return resolved === root || resolved.startsWith(root + sep);
}

const CLAUDE_HOME = join(homedir(), '.claude');
const SKILLS_DIR = join(CLAUDE_HOME, 'skills');
const AGENTS_DIR = join(CLAUDE_HOME, 'agents');
const PROJECTS_DIR = join(CLAUDE_HOME, 'projects');
const USER_PROJECTS_ROOT = join(homedir(), 'Projects');

const PROJECT_SCAN_DEPTH = 6;
const PROJECT_SCAN_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage',
  'venv', '.venv', '__pycache__', 'target', '.idea', '.vscode',
]);

const REGISTRY_CACHE_MS = 5 * 60 * 1000;
const USAGE_CACHE_MS = 2 * 60 * 1000;
const USAGE_LOOKBACK_DAYS = 35;

const SKILL_BLACKLIST = new Set([
  'bash', 'powershell', 'batch', 'cmd', 'shell', 'sh', 'python',
]);

let registryCache = { ts: 0, data: null };
let usageCache = { ts: 0, data: null };
const usageFileCache = new Map();

export function coerceField(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

export function parseFrontmatter(content) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };
  const body = (match[2] || '').trim();
  let raw = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed;
    }
  } catch {
    raw = {};
  }
  const fields = {};
  for (const [k, v] of Object.entries(raw)) {
    fields[k] = coerceField(v);
  }
  return { fields, body };
}

async function scanSkills() {
  const result = [];
  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const skillMdPath = join(SKILLS_DIR, slug, 'SKILL.md');
      try {
        const content = await readFile(skillMdPath, 'utf8');
        const { fields, body } = parseFrontmatter(content);
        result.push({
          slug,
          name: fields.name || slug,
          description: fields.description || '',
          argumentHint: fields['argument-hint'] || '',
          allowedTools: fields['allowed-tools'] || '',
          bodyLength: body.length,
        });
      } catch {
        // SKILL.md missing
      }
    }
  } catch {
    // skills/ missing
  }
  result.sort((a, b) => a.slug.localeCompare(b.slug));
  return result;
}

async function scanSkillsInDir(skillsRoot, includeBody = false) {
  const result = [];
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const skillMdPath = join(skillsRoot, slug, 'SKILL.md');
    try {
      const content = await readFile(skillMdPath, 'utf8');
      const { fields, body } = parseFrontmatter(content);
      const item = {
        slug,
        name: fields.name || slug,
        description: fields.description || '',
        argumentHint: fields['argument-hint'] || '',
        bodyLength: body.length,
        path: skillMdPath,
      };
      if (includeBody) item.body = body;
      result.push(item);
    } catch {}
  }
  result.sort((a, b) => a.slug.localeCompare(b.slug));
  return result;
}

async function scanAgentsInDir(agentsRoot, includeBody = false) {
  const result = [];
  let entries;
  try {
    entries = await readdir(agentsRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const filePath = join(agentsRoot, entry.name);
      try {
        const content = await readFile(filePath, 'utf8');
        const { fields, body } = parseFrontmatter(content);
        const slug = entry.name.replace(/\.md$/, '');
        const item = {
          slug,
          name: fields.name || slug,
          description: fields.description || '',
          tools: fields.tools || '',
          color: fields.color || '',
          bodyLength: body.length,
          path: filePath,
        };
        if (includeBody) item.body = body;
        result.push(item);
      } catch {}
    }
  }
  result.sort((a, b) => a.slug.localeCompare(b.slug));
  return result;
}

async function findClaudeFolders(root, maxDepth) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirNames = new Set();
    for (const e of entries) {
      if (e.isDirectory()) dirNames.add(e.name);
    }
    if (dirNames.has('.claude')) {
      const claudeDir = join(dir, '.claude');
      try {
        const subs = await readdir(claudeDir, { withFileTypes: true });
        const hasSkills = subs.some((s) => s.isDirectory() && s.name === 'skills');
        const hasAgents = subs.some((s) => s.isDirectory() && s.name === 'agents');
        if (hasSkills || hasAgents) {
          found.push({ projectDir: dir, claudeDir, hasSkills, hasAgents });
        }
      } catch {}
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      if (PROJECT_SCAN_IGNORE.has(e.name)) continue;
      if (e.name === '.claude') continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

async function scanProjects() {
  let found;
  try {
    found = await findClaudeFolders(USER_PROJECTS_ROOT, PROJECT_SCAN_DEPTH);
  } catch {
    return [];
  }
  const projects = [];
  for (const f of found) {
    const projectName = basename(f.projectDir);
    const relPath = f.projectDir.replace(USER_PROJECTS_ROOT, '').replace(/^[\\/]/, '');
    const skillsRoot = join(f.claudeDir, 'skills');
    const agentsRoot = join(f.claudeDir, 'agents');
    const [skills, agents] = await Promise.all([
      f.hasSkills ? scanSkillsInDir(skillsRoot, true) : Promise.resolve([]),
      f.hasAgents ? scanAgentsInDir(agentsRoot, true) : Promise.resolve([]),
    ]);
    if (skills.length === 0 && agents.length === 0) continue;
    projects.push({
      name: projectName,
      path: f.projectDir,
      relPath,
      skills,
      agents,
    });
  }
  projects.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return projects;
}

async function scanAgents() {
  const result = [];
  try {
    const domains = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const domain of domains) {
      if (!domain.isDirectory()) continue;
      const domainPath = join(AGENTS_DIR, domain.name);
      try {
        const files = await readdir(domainPath);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const filePath = join(domainPath, file);
          try {
            const content = await readFile(filePath, 'utf8');
            const { fields, body } = parseFrontmatter(content);
            const slug = file.replace(/\.md$/, '');
            result.push({
              slug,
              domain: domain.name,
              name: fields.name || slug,
              description: fields.description || '',
              tools: fields.tools || '',
              color: fields.color || '',
              bodyLength: body.length,
            });
          } catch {
            // skip
          }
        }
      } catch {
        // domain folder unreadable
      }
    }
  } catch {
    // agents/ missing
  }
  result.sort((a, b) => a.slug.localeCompare(b.slug));
  return result;
}

export function skillGroup(slug) {
  if (slug.includes(':')) return slug.split(':')[0];
  const m = slug.match(/^([a-z0-9]+)-/i);
  if (m) return m[1].toLowerCase();
  return 'misc';
}

function startOfMonthKey(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv-SE');
}

function dayKey(iso) {
  return new Date(iso).toLocaleDateString('sv-SE');
}

async function scanFileForUsage(filePath, fileStats) {
  const cached = usageFileCache.get(filePath);
  if (cached && cached.mtimeMs === fileStats.mtimeMs) {
    return cached.usage;
  }
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const skillEvents = [];
  const agentEvents = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message?.content) continue;
    if (!entry.timestamp) continue;
    const day = dayKey(entry.timestamp);
    for (const part of entry.message.content) {
      if (part.type !== 'tool_use') continue;
      if (part.name === 'Skill' && part.input?.skill) {
        const name = part.input.skill;
        if (SKILL_BLACKLIST.has(name.toLowerCase())) continue;
        skillEvents.push({ name, day, ts: entry.timestamp });
      } else if (part.name === 'Task' && part.input?.subagent_type) {
        agentEvents.push({ name: part.input.subagent_type, day, ts: entry.timestamp });
      }
    }
  }
  const usage = { mtimeMs: fileStats.mtimeMs, skillEvents, agentEvents };
  usageFileCache.set(filePath, { mtimeMs: fileStats.mtimeMs, usage });
  return usage;
}

async function aggregateUsage() {
  const now = Date.now();
  if (usageCache.data && now - usageCache.ts < USAGE_CACHE_MS) {
    return usageCache.data;
  }

  const cutoffMs = now - USAGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const monthStart = startOfMonthKey(new Date());
  const skillUsage = new Map();
  const agentUsage = new Map();

  let projectDirs;
  try {
    projectDirs = await readdir(PROJECTS_DIR);
  } catch {
    const empty = { skillUsage: {}, agentUsage: {} };
    usageCache = { ts: now, data: empty };
    return empty;
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(PROJECTS_DIR, projectDir);
    let files;
    try { files = await readdir(projectPath); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(projectPath, file);
      try {
        const fileStats = await stat(filePath);
        if (fileStats.mtimeMs < cutoffMs) continue;
        const usage = await scanFileForUsage(filePath, fileStats);
        if (!usage) continue;
        for (const ev of usage.skillEvents) {
          let bucket = skillUsage.get(ev.name);
          if (!bucket) { bucket = { total: 0, thisMonth: 0, lastUsed: '' }; skillUsage.set(ev.name, bucket); }
          bucket.total += 1;
          if (ev.day >= monthStart) bucket.thisMonth += 1;
          if (!bucket.lastUsed || ev.ts > bucket.lastUsed) bucket.lastUsed = ev.ts;
        }
        for (const ev of usage.agentEvents) {
          let bucket = agentUsage.get(ev.name);
          if (!bucket) { bucket = { total: 0, thisMonth: 0, lastUsed: '' }; agentUsage.set(ev.name, bucket); }
          bucket.total += 1;
          if (ev.day >= monthStart) bucket.thisMonth += 1;
          if (!bucket.lastUsed || ev.ts > bucket.lastUsed) bucket.lastUsed = ev.ts;
        }
      } catch {}
    }
  }

  const skillUsageObj = Object.fromEntries(skillUsage);
  const agentUsageObj = Object.fromEntries(agentUsage);
  const data = { skillUsage: skillUsageObj, agentUsage: agentUsageObj };
  usageCache = { ts: now, data };
  return data;
}

export async function getRegistry() {
  const now = Date.now();
  if (registryCache.data && now - registryCache.ts < REGISTRY_CACHE_MS) {
    return registryCache.data;
  }
  const [skills, agents, usage, projects] = await Promise.all([
    scanSkills(),
    scanAgents(),
    aggregateUsage(),
    scanProjects(),
  ]);

  const skillsWithUsage = skills.map((s) => ({
    ...s,
    group: skillGroup(s.slug),
    usage: usage.skillUsage[s.slug] || { total: 0, thisMonth: 0, lastUsed: '' },
  }));
  const agentsWithUsage = agents.map((a) => ({
    ...a,
    usage: usage.agentUsage[a.slug] || { total: 0, thisMonth: 0, lastUsed: '' },
  }));

  const skillGroups = [...new Set(skillsWithUsage.map((s) => s.group))].sort();
  const agentDomains = [...new Set(agentsWithUsage.map((a) => a.domain))].sort();

  const projectsWithUsage = projects.map((p) => ({
    ...p,
    skills: p.skills.map((s) => ({
      ...s,
      group: skillGroup(s.slug),
      usage: usage.skillUsage[s.slug] || { total: 0, thisMonth: 0, lastUsed: '' },
    })),
    agents: p.agents.map((a) => ({
      ...a,
      usage: usage.agentUsage[a.slug] || { total: 0, thisMonth: 0, lastUsed: '' },
    })),
  }));

  const data = {
    skills: skillsWithUsage,
    agents: agentsWithUsage,
    skillGroups,
    agentDomains,
    projects: projectsWithUsage,
  };
  registryCache = { ts: now, data };
  return data;
}

export async function getSkillDetail(slug) {
  const skillMdPath = join(SKILLS_DIR, slug, 'SKILL.md');
  if (!isInsideDir(skillMdPath, SKILLS_DIR)) return null;
  try {
    const content = await readFile(skillMdPath, 'utf8');
    const { fields, body } = parseFrontmatter(content);
    return {
      slug,
      name: fields.name || slug,
      description: fields.description || '',
      argumentHint: fields['argument-hint'] || '',
      body,
    };
  } catch {
    return null;
  }
}

export async function getAgentDetail(domain, slug) {
  const filePath = join(AGENTS_DIR, domain, `${slug}.md`);
  if (!isInsideDir(filePath, AGENTS_DIR)) return null;
  try {
    const content = await readFile(filePath, 'utf8');
    const { fields, body } = parseFrontmatter(content);
    return {
      slug,
      domain,
      name: fields.name || slug,
      description: fields.description || '',
      tools: fields.tools || '',
      color: fields.color || '',
      body,
    };
  } catch {
    return null;
  }
}

export function invalidateRegistryCache() {
  registryCache = { ts: 0, data: null };
}
