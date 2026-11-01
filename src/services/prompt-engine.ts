/**
 * 提示词渲染引擎
 *
 * 提示词来源：prompts/ 目录下的 .md 文件（自动发现，目录结构即访问路径）
 *
 * 映射规则：
 *   prompts/doc/classify.md   →  path = doc/classify
 *   prompts/hr/recruit.md     →  path = hr/recruit
 *
 * 排除规则：
 *   claude-md.md              →  特殊文件，不作为访问路径
 *   sections/                 →  条件段落目录，不作为访问路径
 *   以 _ 开头的文件或目录      →  不作为访问路径
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

export interface PromptFile {
  filename: string;    // 相对路径，如 doc/classify.md
  path: string;        // 访问路径，如 doc/classify
  name: string;        // 从文件中提取的标题（第一行 #），否则用 filename
  content: string | null;
}

const PROMPT_MAP = new Map<string, PromptFile>();

/** 重新扫描 prompts/ 目录，更新 path→file 映射 */
export function rescanPromptsDir(): PromptFile[] {
  PROMPT_MAP.clear();
  const results: PromptFile[] = [];

  const dirs = [
    resolve(process.cwd(), 'prompts'),
    resolve(process.cwd(), 'dist', 'prompts'),
  ];

  for (const baseDir of dirs) {
    if (!existsSync(baseDir)) continue;

    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('_') || entry === 'sections') continue;
        const full = join(dir, entry);
        const rel = prefix + entry;
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, rel + '/');
        } else if (st.isFile() && entry.endsWith('.md')) {
          const relPath = rel.replace(/\.md$/, ''); // doc/classify
          const basename = entry.replace(/\.md$/, '');

          // claude-md 不作为访问路径
          if (basename === 'claude-md') continue;

          let name = basename;
          let content: string | null = null;
          try {
            content = readFileSync(full, 'utf8');
            const m = content.match(/^#\s+(.+)/m);
            if (m) name = m[1].trim();
          } catch { /* skip */ }

          const pf: PromptFile = { filename: rel, path: relPath, name, content };
          PROMPT_MAP.set(relPath, pf);
          results.push(pf);
        }
      }
    };
    walk(baseDir, '');
    break;
  }

  return results;
}

/** 从 prompts/ 目录读取指定 path 对应的提示词 */
export function loadPromptFromDisk(path: string): string | null {
  // 先从已扫描的 map 中取
  const pf = PROMPT_MAP.get(path);
  if (pf && pf.content !== null) return pf.content;

  // 兜底：path 如 "doc/classify" → 文件 "prompts/doc/classify.md"
  const filename = path + '.md';
  const dirs = [
    resolve(process.cwd(), 'prompts'),
    resolve(process.cwd(), 'dist', 'prompts'),
  ];
  for (const dir of dirs) {
    const p = join(dir, filename);
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8'); } catch { /* */ }
    }
  }
  return null;
}

/** 获取所有已发现的 path 列表 */
export function listAllPaths(): string[] {
  return Array.from(PROMPT_MAP.keys());
}

/** 获取所有 PromptFile */
export function listAllPromptFiles(): PromptFile[] {
  return Array.from(PROMPT_MAP.values());
}

/** path → 显示名称 */
export function pathToName(path: string): string {
  const pf = PROMPT_MAP.get(path);
  return pf?.name ?? path;
}

// 从对象中按点号路径取值
function deepGet(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * 渲染提示词，替换 {{request.*}} 占位符。
 */
export function renderPrompt(template: string, requestBody: Record<string, unknown>): string {
  return template.replace(
    /\{\{(request\.[^}]+)\}\}/g,
    (_match: string, path: string) => {
      const fieldPath = path.replace(/^request\./, '');
      let value: unknown;
      if (fieldPath === 'body') {
        value = requestBody;
      } else {
        value = deepGet(requestBody, fieldPath);
      }
      if (value === undefined || value === null) return '';
      if (typeof value === 'string') return value;
      return JSON.stringify(value, null, 2);
    }
  );
}