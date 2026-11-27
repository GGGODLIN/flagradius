import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = join(REPO_ROOT, 'skills', 'flagradius-safe-rollout');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  expect(match).not.toBeNull();
  const fields: Record<string, string> = {};
  for (const line of match![1].split('\n')) {
    const kv = line.match(/^([a-z0-9-]+):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: match![2] };
}

describe('agentskills.io/specification compliance for flagradius-safe-rollout', () => {
  it('validates frontmatter constraints, parent directory match, and progressive-disclosure budget', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const raw = readFileSync(SKILL_MD, 'utf8');
    const { fields, body } = parseFrontmatter(raw);

    expect(fields.name).toBe('flagradius-safe-rollout');
    expect(fields.name.length).toBeGreaterThanOrEqual(1);
    expect(fields.name.length).toBeLessThanOrEqual(64);
    expect(fields.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(fields.name).not.toContain('--');

    expect(fields.description.length).toBeGreaterThan(20);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    expect(fields.license).toBe('MIT');
    expect(fields.compatibility.length).toBeLessThanOrEqual(500);

    // Progressive-disclosure token efficiency budget: keep SKILL.md lean (<100 lines, <5000 chars)
    const lines = raw.split('\n');
    expect(lines.length).toBeLessThanOrEqual(100);
    expect(raw.length).toBeLessThan(5000);

    // Verify all referenced files exist and no local machine paths or secret literals leaked
    expect(body).toContain('references/cli-jq-recipes.md');
    expect(existsSync(join(SKILL_DIR, 'references', 'cli-jq-recipes.md'))).toBe(true);
    expect(raw).not.toMatch(/\/Users\/|\/home\/|ser\.[A-Za-z0-9]{10,}|ghp_/);

    const recipes = readFileSync(join(SKILL_DIR, 'references', 'cli-jq-recipes.md'), 'utf8');
    expect(recipes).toContain('--no-input');
    expect(recipes).toContain('--jq');
    expect(recipes).not.toMatch(/\/Users\/|\/home\/|ser\.[A-Za-z0-9]{10,}|ghp_/);
  });
});
