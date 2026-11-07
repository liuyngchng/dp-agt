/**
 * XMind 解析 — 将 .xmind 文件转换为 Markdown 文本，供记忆库使用。
 *
 * .xmind 本质是 ZIP 包，内含 content.xml（脑图结构）。
 * 解析 content.xml 中的 <topic> 树，递归生成缩进 Markdown 列表。
 * 仅依赖纯 JS 的 fast-xml-parser + adm-zip，无原生编译依赖，可直接打包进 dist。
 */
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

/** 提取 ZIP 中 content.xml 的文本内容 */
function readContentXml(buf: Buffer): string {
  const zip = new AdmZip(buf);
  // XMind 8: content.xml；XMind 2020+（zen）: content.json
  const xmlEntry = zip.getEntry('content.xml');
  if (xmlEntry) {
    return xmlEntry.getData().toString('utf8');
  }
  const jsonEntry = zip.getEntry('content.json');
  if (jsonEntry) {
    throw new Error('暂不支持 XMind 2020+ 的 content.json 格式，请另存为旧版 .xmind 或导出为 Markdown');
  }
  throw new Error('无法在 .xmind 中找到 content.xml');
}

/** 递归查找第一个带 title 的 topic 节点（作为根主题） */
function findRootTopic(node: any): any {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.title === 'string' && node.title.trim()) {
    return node;
  }
  for (const key of Object.keys(node)) {
    if (key === 'title' || key === 'children' || key === 'topics') continue;
    const found = findRootTopic(node[key]);
    if (found) return found;
  }
  return null;
}

/** 提取某 topic 的子 topic 数组 */
function getChildTopics(topic: any): any[] {
  if (!topic || typeof topic !== 'object') return [];
  // 结构：topic.children.topics.topic（单个或数组）
  const children = topic.children;
  if (!children || typeof children !== 'object') return [];
  const topics = children.topics;
  if (!topics || typeof topics !== 'object') return [];
  const t = topics.topic;
  if (!t) return [];
  return Array.isArray(t) ? t : [t];
}

/** 递归将 topic 树渲染为缩进 Markdown 列表 */
function renderTopic(topic: any, depth: number, lines: string[]): void {
  const title = (typeof topic.title === 'string' ? topic.title : '').trim();
  if (title) {
    lines.push('  '.repeat(depth) + '- ' + title);
  }
  for (const kid of getChildTopics(topic)) {
    renderTopic(kid, depth + 1, lines);
  }
}

/**
 * 将 .xmind 文件 buffer 解析为 Markdown 字符串。
 * @throws 当无法解析时抛出中文错误
 */
export function xmindToMarkdown(buf: Buffer): string {
  const xml = readContentXml(buf);

  let parsed: any;
  try {
    const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
    parsed = parser.parse(xml);
  } catch {
    throw new Error('content.xml 解析失败，文件可能已损坏');
  }

  // 在整棵树中查找根主题（兼容不同 XMind 版本的节点名差异）
  const root = findRootTopic(parsed);
  if (!root) {
    throw new Error('无法识别脑图结构，请确认是有效的 .xmind 文件');
  }

  const lines: string[] = [];
  const rootTitle = (typeof root.title === 'string' ? root.title : '').trim();
  if (rootTitle) {
    lines.push('# ' + rootTitle);
    lines.push('');
  }
  // 根主题已作为标题，仅递归渲染其子节点，避免标题重复
  for (const kid of getChildTopics(root)) {
    renderTopic(kid, 0, lines);
  }
  return lines.join('\n');
}
