import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolveFlagsmithCliPath } from '../src/flagsmith-adapter.js';
import { generateRoster } from '../src/roster.js';

const bootstrap = (environmentName: 'Prod' | 'Parity') => `
import json
from api_keys.models import MasterAPIKey
from environments.models import Environment
from organisations.models import Organisation
from projects.models import Project

org = Organisation.objects.create(name='FlagRadius sandbox', persist_trait_data=True)
project = Project.objects.create(name='FlagRadius sandbox', organisation=org)
env = Environment.objects.create(name='${environmentName}', project=project)
_, token = MasterAPIKey.objects.create_key(name='Disposable parity verifier', organisation=org)
print('SANDBOX_JSON=' + json.dumps({'projectId': project.id, 'environmentKey': env.api_key, 'apiToken': token}))
`;

async function seed() {
  const origin = new URL(process.env.SANDBOX_ORIGIN ?? '');
  const secretFile = process.env.SANDBOX_TOKEN_FILE;
  const demoSeedFile = process.env.FLAGRADIUS_DEMO_SEED_FILE;
  const projectName = process.env.COMPOSE_PROJECT_NAME ?? '';
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !secretFile ||
    !(demoSeedFile ? projectName.startsWith('flagradius-demo-') : projectName.startsWith('flagradius-parity-'))) {
    throw new Error('Seed requires the isolated loopback Compose sandbox.');
  }
  const bootOutput = execFileSync('docker', ['compose', 'exec', '-T', 'flagsmith', 'python', 'manage.py', 'shell', '-c',
    bootstrap(demoSeedFile ? 'Prod' : 'Parity')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const marker = bootOutput.split('\n').find(line => line.startsWith('SANDBOX_JSON='));
  if (!marker) throw new Error('Docker bootstrap did not return the sandbox configuration.');
  const { projectId, environmentKey, apiToken } = JSON.parse(marker.slice('SANDBOX_JSON='.length)) as { projectId: number; environmentKey: string; apiToken: string };
  const apiUrl = `${origin.origin}/api/v1/`;
  const scoped = `FLAGSMITH_API_KEY_${origin.host.replace(/[.:]/g, '_')}`;
  const featureOutput = execFileSync(resolveFlagsmithCliPath(), [
    'feature', 'create', 'new_search', '--value=control', '--variants=[{"value":"a","weight":0},{"value":"b","weight":0}]',
    `--api-url=${origin.origin}`, `--project=${projectId}`, '--no-input', '--yes', '--json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, HOME: process.env.SANDBOX_HOME, XDG_CONFIG_HOME: process.env.SANDBOX_HOME, XDG_CACHE_HOME: process.env.SANDBOX_HOME, [scoped]: apiToken } });
  const feature = JSON.parse(featureOutput) as { variants?: { id: number; value: string }[] };
  const variantIds = ['a', 'b'].map(name => feature.variants?.find(variant => variant.value === name)?.id);
  if (variantIds.some(id => !id)) throw new Error('Seed feature did not include both multivariate variants.');
  async function createSegment(name: string) {
    const segment = await fetch(`${apiUrl}projects/${projectId}/segments/`, {
      method: 'POST', headers: { Authorization: `Api-Key ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rules: [{ type: 'ALL', conditions: [{ operator: 'EQUAL', property: 'cohort', value: name }], rules: [] }] }),
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!segment.ok) throw new Error(`Segment seed failed (HTTP ${segment.status}).`);
    const { id } = await segment.json() as { id: number };
    if (!Number.isSafeInteger(id)) throw new Error('Seed segment did not return a numeric ID.');
    return id;
  }
  const segmentId = await createSegment('internal_testers');
  const vipSegmentId = demoSeedFile ? await createSegment('vip') : undefined;

  const roster = generateRoster();
  for (let start = 0; start < roster.length; start += 20) {
    await Promise.all(roster.slice(start, start + 20).map(async ({ identifier, traits }) => {
      const response = await fetch(`${apiUrl}identities/`, {
        method: 'POST', headers: { 'X-Environment-Key': environmentKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, traits: Object.entries(traits).map(([trait_key, trait_value]) => ({ trait_key, trait_value })) }),
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Identity seed failed (HTTP ${response.status}).`);
      const seeded = await response.json() as { identifier: string };
      if (seeded.identifier !== identifier) throw new Error('Server did not acknowledge the seeded identity.');
    }));
  }
  const identities = await fetch(`${apiUrl}environments/${environmentKey}/identities/?page_size=1`, {
    headers: { Authorization: `Api-Key ${apiToken}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!identities.ok) throw new Error(`Identity count failed (HTTP ${identities.status}).`);
  const { count: registeredIdentities } = await identities.json() as { count: number };
  if (registeredIdentities !== roster.length) throw new Error('Server identity count did not match the synthetic roster.');
  await writeFile(secretFile, apiToken, { mode: 0o600 });
  await writeFile(demoSeedFile ?? 'parity-report/sandbox.json',
    JSON.stringify({ apiUrl, projectId, environmentKey, segmentId, vipSegmentId, variantIds, registeredIdentities }), { mode: 0o600 });
  console.log(JSON.stringify({ mode: 'LIVE_FLAGSMITH', registeredIdentities, internalTesters: roster.filter(user => user.traits.cohort === 'internal_testers').length, vipIdentities: roster.filter(user => user.vip).length }));
}

await seed().catch(error => {
  console.error(JSON.stringify({ mode: 'LIVE_FLAGSMITH', stage: 'seed', failure: error instanceof Error && error.constructor === Error && !('status' in error) ? error.message : 'Sandbox setup command failed.' }));
  process.exitCode = 1;
});
