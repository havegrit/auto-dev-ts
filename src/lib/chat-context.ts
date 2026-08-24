import { open, readdir, realpath, stat } from 'fs/promises';
import { basename, extname, resolve, sep } from 'path';
import { complete, parseJsonLoose } from './complete.js';
import { resolveProjectDir } from './workspace.js';

export const CHAT_MAX_FILES = 8;
export const CHAT_MAX_FILE_BYTES = 100 * 1024;

const MAX_DISCOVERED_FILES = 2_500;
const MAX_DISCOVERED_DIRS = 1_000;
const MAX_TREE_CHARS = 20_000;
const SAMPLE_BYTES = 8 * 1024;
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);
const BINARY_EXTENSIONS = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.dll', '.dmg', '.doc', '.docx',
  '.eot', '.exe', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.lockb', '.mov',
  '.mp3', '.mp4', '.o', '.obj', '.otf', '.pdf', '.png', '.so', '.tar', '.tiff', '.ttf',
  '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip',
]);
const SENSITIVE_EXTENSIONS = new Set(['.cer', '.crt', '.der', '.key', '.p12', '.pfx', '.pem']);
const SENSITIVE_BASENAMES = new Set([
  '.dockerconfigjson', '.git-credentials', '.netrc', '.npmrc', '.pypirc',
  'authorized_keys', 'credentials', 'credentials.json', 'id_dsa', 'id_ed25519', 'id_rsa',
]);

interface ProjectFile {
  path: string;
  absolutePath: string;
  size: number;
  score: number;
  sample?: string;
}

export interface ProjectChatContext {
  text: string;
  files: string[];
  usedHybridSelection: boolean;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

export function isSensitiveChatPath(path: string): boolean {
  const parts = pathSegments(path);
  return parts.some((part) => {
    const lower = part.toLowerCase();
    if (lower.startsWith('.env') || SENSITIVE_BASENAMES.has(lower)) return true;
    if (SENSITIVE_EXTENSIONS.has(extname(lower))) return true;
    return /(^|[._-])(secret|secrets|credential|credentials|token|tokens|certificate|certificates)([._-]|$)/i.test(lower);
  });
}

function isExcludedDirectory(path: string): boolean {
  return pathSegments(path).some((part) => EXCLUDED_DIRS.has(part.toLowerCase()));
}

async function readPrefix(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

async function safeTextPrefix(file: ProjectFile, rootReal: string, maxBytes: number): Promise<string | undefined> {
  const currentReal = await realpath(file.absolutePath).catch(() => '');
  if (!currentReal || !isInside(rootReal, currentReal)) return undefined;
  const buffer = await readPrefix(currentReal, maxBytes).catch(() => Buffer.alloc(0));
  return decodeText(buffer);
}

async function discoverFiles(project: string): Promise<{ rootReal: string; files: ProjectFile[] }> {
  if (!project.trim()) throw new Error('project is required in project chat mode');
  const workspaceReal = await realpath(resolveProjectDir()).catch(() => '');
  const projectPath = resolveProjectDir(project);
  const rootReal = await realpath(projectPath).catch(() => '');
  if (!workspaceReal || !rootReal || !isInside(workspaceReal, rootReal)) {
    throw new Error(`Invalid or missing project: ${project}`);
  }
  const rootStat = await stat(rootReal);
  if (!rootStat.isDirectory()) throw new Error(`Project is not a directory: ${project}`);

  const files: ProjectFile[] = [];
  const queue: Array<{ absolutePath: string; displayPath: string }> = [{ absolutePath: rootReal, displayPath: '' }];
  const visitedDirs = new Set<string>([rootReal]);

  while (queue.length > 0 && files.length < MAX_DISCOVERED_FILES && visitedDirs.size <= MAX_DISCOVERED_DIRS) {
    const dir = queue.shift()!;
    const entries = await readdir(dir.absolutePath, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const displayPath = dir.displayPath ? `${dir.displayPath}/${entry.name}` : entry.name;
      if (isExcludedDirectory(displayPath) || isSensitiveChatPath(displayPath)) continue;

      const lexicalPath = resolve(dir.absolutePath, entry.name);
      const targetReal = await realpath(lexicalPath).catch(() => '');
      if (!targetReal || !isInside(rootReal, targetReal)) continue;
      const targetStat = await stat(targetReal).catch(() => null);
      if (!targetStat) continue;

      if (targetStat.isDirectory()) {
        if (!visitedDirs.has(targetReal) && visitedDirs.size < MAX_DISCOVERED_DIRS) {
          visitedDirs.add(targetReal);
          queue.push({ absolutePath: targetReal, displayPath });
        }
        continue;
      }
      if (!targetStat.isFile() || BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const sampleBuffer = await readPrefix(targetReal, Math.min(SAMPLE_BYTES, targetStat.size)).catch(() => Buffer.alloc(0));
      const sample = decodeText(sampleBuffer);
      if (sample === undefined) continue;
      files.push({ path: displayPath, absolutePath: targetReal, size: targetStat.size, score: 0, sample });
      if (files.length >= MAX_DISCOVERED_FILES) break;
    }
  }
  return { rootReal, files };
}

function queryTokens(question: string): string[] {
  return [...new Set((question.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])
    .filter((token) => !['the', 'and', 'for', 'with', 'this', 'that', 'what', 'how', '프로젝트', '파일'].includes(token)))]
    .slice(0, 30);
}

function scoreFiles(files: ProjectFile[], question: string): ProjectFile[] {
  const tokens = queryTokens(question);
  for (const file of files) {
    const path = file.path.toLowerCase();
    const sample = (file.sample ?? '').toLowerCase();
    let score = /^readme(?:\.|$)/i.test(basename(file.path)) ? 2 : 0;
    for (const token of tokens) {
      if (path.includes(token)) score += 6;
      const matches = sample.split(token).length - 1;
      score += Math.min(matches, 4);
    }
    file.score = score;
  }
  return [...files].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function readmeFile(files: ProjectFile[]): ProjectFile | undefined {
  return files
    .filter((file) => /^readme(?:\.|$)/i.test(basename(file.path)))
    .sort((a, b) => pathSegments(a.path).length - pathSegments(b.path).length || a.path.localeCompare(b.path))[0];
}

async function selectPathsWithModel(question: string, files: ProjectFile[], model?: string, signal?: AbortSignal): Promise<string[]> {
  const candidates = files.slice(0, 600).map((file) => file.path);
  if (candidates.length === 0) return [];
  const response = await complete({
    model,
    signal,
    json: true,
    system: '프로젝트 질문과 관련된 파일 경로만 고르는 분류기다. 파일을 읽거나 수정하지 않는다.',
    message: [
      `질문: ${question}`,
      '',
      '후보 경로:',
      candidates.join('\n'),
      '',
      `가장 관련 있는 경로를 최대 ${CHAT_MAX_FILES}개 선택해 {"paths":["path"]} 형식으로 답하라. 후보에 있는 정확한 경로만 사용하라.`,
    ].join('\n'),
  });
  try {
    const parsed = parseJsonLoose(response) as { paths?: unknown };
    return Array.isArray(parsed.paths) ? parsed.paths.filter((path): path is string => typeof path === 'string') : [];
  } catch {
    return [];
  }
}

function treeText(files: ProjectFile[]): string {
  const full = files.map((file) => file.path).join('\n');
  return full.length <= MAX_TREE_CHARS ? full : `${full.slice(0, MAX_TREE_CHARS)}\n…(파일 목록 생략)`;
}

export async function buildProjectChatContext(project: string, question: string, model?: string, signal?: AbortSignal): Promise<ProjectChatContext> {
  const { rootReal, files } = await discoverFiles(project);
  const scored = scoreFiles(files, question);
  const readme = readmeFile(files);
  const lowConfidence = (scored[0]?.score ?? 0) <= 2;
  const modelPaths = lowConfidence
    ? await selectPathsWithModel(question, scored, model, signal).catch((err) => {
      if (signal?.aborted) throw err;
      return [];
    })
    : [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const selected: ProjectFile[] = [];
  const add = (file: ProjectFile | undefined) => {
    if (file && !selected.some((item) => item.path === file.path) && selected.length < CHAT_MAX_FILES) selected.push(file);
  };
  add(readme);
  for (const path of modelPaths) add(byPath.get(path));
  for (const file of scored) {
    if (file.score > 0 || selected.length === 0) add(file);
    if (selected.length >= CHAT_MAX_FILES) break;
  }

  let remaining = CHAT_MAX_FILE_BYTES;
  const sections: string[] = [];
  const included: string[] = [];
  for (const file of selected) {
    if (remaining <= 0) break;
    const limit = Math.min(file.size, remaining);
    const content = await safeTextPrefix(file, rootReal, limit);
    if (content === undefined) continue;
    const bytes = Buffer.byteLength(content);
    remaining -= bytes;
    included.push(file.path);
    sections.push(`### ${file.path}\n${content}${file.size > limit ? '\n…(파일 내용 생략)' : ''}`);
  }

  return {
    text: [
      `프로젝트: ${project}`,
      '',
      '필터된 파일 목록:',
      treeText(files),
      '',
      '관련 파일 내용:',
      sections.length > 0 ? sections.join('\n\n') : '(관련 텍스트 파일 없음)',
    ].join('\n'),
    files: included,
    usedHybridSelection: lowConfidence,
  };
}
