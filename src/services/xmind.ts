/**
 * XMind 解析 — 将 .xmind 文件转换为 Markdown 文本，供记忆库使用。
 *
 * .xmind 本质是 ZIP 包，内含脑图结构：
 *   - XMind 2020+（Zen）: content.json（真实内容）；同时附带一份 content.xml（旧版兼容警告占位）
 *   - XMind 8:           content.xml（真实内容）
 * 因此优先解析 content.json，仅当其不存在时才回退到 content.xml。
 * 仅依赖纯 JS 的 fast-xml-parser + adm-zip，无原生编译依赖，可直接打包进 dist。
 */
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

/** 归一化：把 undefined / 单个值 / 数组 统一成数组 */
function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 缩进两空格 */
function indent(depth: number): string {
  return '  '.repeat(depth);
}

/** 取 topic 的 title，去空白 */
function topicTitle(topic: any): string {
  return typeof topic?.title === 'string' ? topic.title.trim() : '';
}

/** 读取 ZIP 内某个文本条目，去除 BOM；不存在返回 null */
function readZipText(buf: Buffer, name: string): string | null {
  const zip = new AdmZip(buf);
  const entry = zip.getEntry(name);
  if (!entry) return null;
  return entry.getData().toString('utf8').replace(/^﻿/, '');
}

/* ---------------- content.json（XMind 2020+ / Zen） ---------------- */

/** 子主题：attached（分支）+ detached（自由主题） */
function jsonChildren(topic: any): any[] {
  return [...asArray(topic?.children?.attached), ...asArray(topic?.children?.detached)];
}

function renderJsonTopic(topic: any, depth: number, lines: string[]): void {
  const title = topicTitle(topic);
  if (title) lines.push(indent(depth) + '- ' + title);

  for (const kid of jsonChildren(topic)) {
    renderJsonTopic(kid, depth + 1, lines);
  }

  // 摘要（summary）与批注（callout）作为附加说明，跟在子主题之后
  for (const s of asArray(topic?.children?.summary)) {
    const st = topicTitle(s);
    if (st) lines.push(indent(depth + 1) + '- 小结：' + st);
  }
  for (const c of asArray(topic?.children?.callout)) {
    const ct = topicTitle(c);
    if (ct) lines.push(indent(depth + 1) + '- 备注：' + ct);
  }
}

function jsonToMarkdown(text: string): string {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('content.json 解析失败，文件可能已损坏');
  }

  const sheets = asArray(data).filter((s: any) => s?.class === 'sheet');
  if (sheets.length === 0) {
    throw new Error('无法识别脑图结构，请确认是有效的 .xmind 文件');
  }

  const lines: string[] = [];
  const multi = sheets.length > 1;
  for (const sheet of sheets) {
    const root = sheet?.rootTopic ?? sheet;
    const title = topicTitle(root) || topicTitle(sheet);
    if (title) {
      lines.push((multi ? '## ' : '# ') + title);
      lines.push('');
    }
    for (const kid of jsonChildren(root)) {
      renderJsonTopic(kid, 0, lines);
    }
    if (title) lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

/* ---------------- content.xml（XMind 8） ---------------- */

/** 子主题：topic.children.topics.topic */
function xmlChildren(topic: any): any[] {
  return asArray(topic?.children?.topics?.topic);
}

function renderXmlTopic(topic: any, depth: number, lines: string[]): void {
  const title = topicTitle(topic);
  if (title) lines.push(indent(depth) + '- ' + title);
  for (const kid of xmlChildren(topic)) {
    renderXmlTopic(kid, depth + 1, lines);
  }
}

function xmlToMarkdown(text: string): string {
  let parsed: any;
  try {
    const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
    parsed = parser.parse(text);
  } catch {
    throw new Error('content.xml 解析失败，文件可能已损坏');
  }

  const xmap = parsed?.['xmap-content'];
  const sheets = asArray(xmap?.sheet);
  if (sheets.length === 0) {
    throw new Error('无法识别脑图结构，请确认是有效的 .xmind 文件');
  }

  const lines: string[] = [];
  const multi = sheets.length > 1;
  for (const sheet of sheets) {
    // sheet 下的 topic 才是中心主题；sheet 自身的 <title>（如 "Sheet 1"）不是内容
    for (const root of asArray(sheet?.topic)) {
      const title = topicTitle(root);
      if (title) {
        lines.push((multi ? '## ' : '# ') + title);
        lines.push('');
      }
      for (const kid of xmlChildren(root)) {
        renderXmlTopic(kid, 0, lines);
      }
      if (title) lines.push('');
    }
  }

  const md = lines.join('\n').trim() + '\n';
  // XMind 新版把 content.xml 用作「旧版兼容警告」占位，若解析结果实为警告说明真实内容已丢失
  if (/无法正常打开|can not be opened normally|cannot be opened normally/i.test(md)) {
    throw new Error('该 .xmind 为旧版兼容占位文件，真实内容已丢失，请用新版 XMind 重新导出');
  }
  return md;
}

/**
 * 将 .xmind 文件 buffer 解析为 Markdown 字符串。
 * @throws 当无法解析时抛出中文错误
 */
export function xmindToMarkdown(buf: Buffer): string {
  const jsonText = readZipText(buf, 'content.json');
  if (jsonText !== null) {
    return jsonToMarkdown(jsonText);
  }
  const xmlText = readZipText(buf, 'content.xml');
  if (xmlText !== null) {
    return xmlToMarkdown(xmlText);
  }
  throw new Error('无法在 .xmind 中找到 content.json 或 content.xml');
}
