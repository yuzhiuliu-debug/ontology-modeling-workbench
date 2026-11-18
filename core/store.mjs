import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA_ROOT } from './paths.mjs';

export const DATA_DIR = path.join(DATA_ROOT, 'jobs');
export const SAMPLE_DIR = path.join(ROOT, 'samples');
export const STAGES = ['ingested', 'canonicalized', 'reviewed', 'compiled', 'validated', 'graphed', 'published'];

export const sha = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const uid = prefix => prefix + '-' + crypto.randomUUID().slice(0, 8);
const jobDir = id => path.join(DATA_DIR, id);
const metaPath = id => path.join(jobDir(id), 'job.json');
const artifactDir = id => path.join(jobDir(id), 'artifacts');

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}
export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function createJob({ name, namespace, sources }) {
  const id = uid('job');
  const now = new Date().toISOString();
  const job = {
    id, name, namespace,
    createdAt: now, updatedAt: now,
    stage: 'created', current: 0,
    sources: sources.map(s => ({ id: s.id, name: s.name, type: s.type, sha256: s.sha256, bytes: s.bytes })),
    stages: Object.fromEntries(STAGES.map(s => [s, { status: 'pending', at: null }])),
    blockers: [], conflicts: [], artifacts: [], log: [],
    stats: {}, modelVersion: null
  };
  await writeJson(metaPath(id), job);
  await writeJson(path.join(jobDir(id), 'materials.json'), sources);
  return job;
}

export async function getJob(id) {
  if (!/^job-[0-9a-f-]+$/.test(id)) throw Error('作业编号无效');
  return readJson(metaPath(id));
}
export async function listJobs() {
  await mkdir(DATA_DIR, { recursive: true });
  const dirs = await readdir(DATA_DIR);
  const jobs = [];
  for (const d of dirs) {
    try { jobs.push(await readJson(path.join(DATA_DIR, d, 'job.json'))); } catch { /* skip */ }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function updateJob(id, patch) {
  const job = await getJob(id);
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  await writeJson(metaPath(id), next);
  return next;
}
export async function log(jobId, stage, message, level = 'info') {
  const job = await getJob(jobId);
  job.log.push({ at: new Date().toISOString(), stage, level, message });
  job.updatedAt = new Date().toISOString();
  await writeJson(metaPath(jobId), job);
}
export async function completeStage(id, stage, extra = {}) {
  const job = await getJob(id);
  job.stages[stage] = { status: 'done', at: new Date().toISOString() };
  job.current = Math.max(job.current, STAGES.indexOf(stage) + 1);
  job.stage = STAGES[Math.min(job.current, STAGES.length - 1)];
  Object.assign(job.stats, extra.stats || {});
  if (extra.blockers) job.blockers = extra.blockers;
  if (extra.conflicts) job.conflicts = extra.conflicts;
  if (extra.modelVersion) job.modelVersion = extra.modelVersion;
  job.updatedAt = new Date().toISOString();
  await writeJson(metaPath(id), job);
  return job;
}
export async function putArtifact(id, name, content, mediaType = 'application/json') {
  const dir = artifactDir(id);
  await mkdir(dir, { recursive: true });
  const body = typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2);
  await writeFile(path.join(dir, name), body, 'utf8');
  const job = await getJob(id);
  const bytes = Buffer.byteLength(body);
  const entry = { name, mediaType, bytes, sha256: sha(body) };
  job.artifacts = [...job.artifacts.filter(a => a.name !== name), entry];
  job.updatedAt = new Date().toISOString();
  await writeJson(metaPath(id), job);
  return entry;
}
export async function getArtifact(id, name) {
  if (!/^[\w.-]+$/.test(name)) throw Error('产物名无效');
  return readFile(path.join(artifactDir(id), name), 'utf8');
}
export async function getMaterials(id) {
  return readJson(path.join(jobDir(id), 'materials.json'));
}
