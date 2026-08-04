// Shared helpers used by sessions.js, stats.js, and registry.js.
// Each was previously duplicated across two or three modules — single source
// of truth now lives here.

// Tool names that claude-mem's observer wrapper exposes via the "Skill" tool
// but which are NOT real Claude Code skills (they are shell wrappers used
// internally by claude-mem). Filter them out of skill detection so the
// dashboard doesn't display "bash" / "powershell" / "batch" as skills.
export const SKILL_BLACKLIST = new Set([
  'bash',
  'powershell',
  'batch',
  'cmd',
  'shell',
  'sh',
  'python',
]);

// Claude Code stores per-project session files in folders named by encoding
// the working directory: drive letter prefix + the rest of the path with
// path separators replaced by dashes. Examples:
//   c--Users-Egils-Varna-Projects-EV-02-data-gov-lv
//   C--Users-someone-source-repos-myapp
//   home-john-dev-some-project   (no Windows drive prefix)
// This function reverses that encoding back to the original path.
export function decodeProjectDirName(dirName) {
  if (/^[a-z]--/i.test(dirName)) {
    const drive = dirName[0].toUpperCase();
    const rest = dirName.slice(3).replace(/-/g, '\\');
    return `${drive}:\\${rest}`;
  }
  return dirName.replace(/-/g, '/');
}

// Last path segment, normalised. Used as a friendly project name for display.
export function shortProjectName(fullPath) {
  if (!fullPath) return 'unknown';
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

// Local-time YYYY-MM-DD bucket for an ISO timestamp. Used for grouping
// activity by day (`sv-SE` locale is the easiest way to get ISO date format
// in any timezone).
export function dayKey(isoTimestamp) {
  return new Date(isoTimestamp).toLocaleDateString('sv-SE');
}

// Normalise a JSONL usage object. cache_creation carries the per-TTL split on
// newer Claude Code versions; when absent, treat the whole legacy
// cache_creation_input_tokens figure as a 5-minute-TTL write.
export function usageBreakdown(usage) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const split = usage.cache_creation;
  let cacheCreate5m;
  let cacheCreate1h;
  if (split && (split.ephemeral_5m_input_tokens != null || split.ephemeral_1h_input_tokens != null)) {
    cacheCreate5m = split.ephemeral_5m_input_tokens || 0;
    cacheCreate1h = split.ephemeral_1h_input_tokens || 0;
  } else {
    cacheCreate5m = usage.cache_creation_input_tokens || 0;
    cacheCreate1h = 0;
  }
  return {
    input,
    output,
    cacheRead,
    cacheCreate5m,
    cacheCreate1h,
    total: input + output + cacheRead + cacheCreate5m + cacheCreate1h,
  };
}
