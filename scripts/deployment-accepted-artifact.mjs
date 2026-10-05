#!/usr/bin/env node
/** Select an immutable artifact from a completed successful staging run in this exact repository. */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Require an actually successful staging deployment, not merely an uploaded package or unrelated run. */
export function acceptedArtifact(run, jobs, artifacts, repository) {
  if (run.repository?.full_name !== repository || run.path !== '.github/workflows/ci.yml' || run.status !== 'completed' || run.conclusion !== 'success' || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) throw new Error('Only a successful delivery run from this repository is accepted.');
  if (!jobs.some((job) => job.name === 'Deploy staging' && job.conclusion === 'success')) throw new Error('The selected artifact has not completed staging deployment.');
  const artifact = artifacts.find((item) => item.name === `staging-${run.head_sha}` && !item.expired);
  if (!artifact) throw new Error('Accepted staging artifact is missing or expired.');
  return { source: run.head_sha, name: artifact.name };
}

/** Read bounded GitHub metadata using the job token; never print provider bodies or credentials. */
async function main() {
  const id = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!/^[1-9][0-9]{0,19}$/.test(id ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !token) throw new Error('Explicit artifact run ID, current repository and Actions token are required.');
  const get = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${id}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Accepted-artifact metadata lookup failed (${response.status}).`);
    return response.json();
  };
  const [run, jobs, artifacts] = await Promise.all([get(''), get('/jobs?per_page=100'), get('/artifacts?per_page=100')]);
  const selected = acceptedArtifact(run, jobs.jobs, artifacts.artifacts, repository);
  if (!process.env.GITHUB_OUTPUT) throw new Error('Artifact selection requires the Actions output channel.');
  appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${selected.source}\nartifact_name=${selected.name}\n`);
  process.stdout.write(`Accepted verified staging source ${selected.source}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
