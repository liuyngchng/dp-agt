/**
 * 记忆库存储 — Claude Agent SDK 按需业务知识库
 *
 * 记忆文件存放于 data/memory/（运行时数据，不进 git）。
 * 每个 .md 文件是一份业务背景知识（领导分工、部门职责、业务流程等），
 * 通过 CLAUDE.md 中的索引注入，Claude 处理任务时按需 Read 读取完整内容。
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface MemoryItem {
  filename: string;      // 文件名，如 公司领导班子成员工作分工.md
  title: string;         // 从文件第一行 # 提取
  description: string;   // 标题后第一个非空段落，作为一句话说明
  size: number;          // 文件字节数
}

/** 解析单个 .md 文件的标题与说明 */
function parseMemory(filePath: string, filename: string): MemoryItem {
  let title = filename.replace(/\.md$/i, '');
  let description = '';
  const size = statSync(filePath).size;
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^#\s+(.+)/);
      if (m) {
        title = m[1].trim();
        break;
      }
    }
    // 说明：标题行之后第一个非空、非纯标题段落
    let afterTitle = false;
    for (const line of lines) {
      if (afterTitle && line.trim() && !line.startsWith('#')) {
        description = line.trim().replace(/[>\-*|#`]/g, '').trim();
        break;
      }
      if (line.startsWith('#')) afterTitle = true;
    }
  } catch { /* ignore */ }
  return { filename, title, description, size };
}

export function getMemoryDir(dataDir: string): string {
  return join(dataDir, 'memory');
}

export function ensureMemoryDir(dataDir: string): string {
  const dir = getMemoryDir(dataDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 列出所有记忆文件 */
export function listMemories(dataDir: string): MemoryItem[] {
  const dir = getMemoryDir(dataDir);
  if (!exists(dir)) return [];
  const items: MemoryItem[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    items.push(parseMemory(full, entry));
  }
  items.sort((a, b) => a.filename.localeCompare(b.filename));
  return items;
}

/** 读取单个记忆文件内容 */
export function getMemory(dataDir: string, filename: string): string | null {
  const safe = sanitizeFilename(filename);
  if (!safe) return null;
  const full = join(getMemoryDir(dataDir), safe);
  if (!exists(full)) return null;
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/** 写入记忆文件（同名覆盖） */
export function saveMemory(dataDir: string, filename: string, content: string): string {
  ensureMemoryDir(dataDir);
  const safe = sanitizeFilename(filename);
  if (!safe) throw new Error('非法文件名: ' + filename);
  const full = join(getMemoryDir(dataDir), safe);
  writeFileSync(full, content, 'utf8');
  return safe;
}

/** 删除记忆文件 */
export function deleteMemory(dataDir: string, filename: string): boolean {
  const safe = sanitizeFilename(filename);
  if (!safe) return false;
  const full = join(getMemoryDir(dataDir), safe);
  if (!exists(full)) return false;
  rmSync(full, { force: true });
  return true;
}

/** 文件名安全校验：仅保留 basename，拒绝路径穿越 */
function sanitizeFilename(filename: string): string {
  const b = basename(filename.replace(/\\/g, '/'));
  if (!b || b === '.' || b === '..') return '';
  if (!b.endsWith('.md')) return '';
  return b;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
