/**
 * 进程树管理 — 定位并强制终止任务工作目录下的 SDK 子进程树。
 *
 * SDK 不暴露子进程 PID，但子进程的 cwd 就是任务工作目录（按 linkid 唯一），
 * 通过 /proc 扫描定位：优先找父进程为本网关、cwd 在工作目录下的进程（即 SDK
 * 直接派生的 CLI 子进程），兜底匹配所有 cwd 在工作目录下的进程；然后杀掉它们
 * 及全部后代（后代可能已 cd 到别处，如工具执行 cd /tmp）。
 *
 * 从 task-queue.ts 抽出，供控制面与 runner 两侧的看门狗复用。
 */
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';

export function killTaskProcessTree(workDir: string): number {
  if (process.platform !== 'linux') return 0;

  let canonicalWorkDir: string;
  try {
    canonicalWorkDir = realpathSync(workDir);
  } catch {
    return 0; // 目录已不存在，没有可杀的进程
  }

  // 收集 /proc 下所有进程的 cwd 与父进程关系
  const procs = new Map<number, { cwd: string; ppid: number }>();
  try {
    for (const entry of readdirSync('/proc')) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || pid === 1) continue;
      try {
        let cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (cwd.endsWith(' (deleted)')) cwd = cwd.slice(0, -' (deleted)'.length);
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const m = /^\d+ \(.*\) [A-Za-z] (\d+)/.exec(stat);
        if (m) procs.set(pid, { cwd, ppid: Number(m[1]) });
      } catch { /* 进程已退出或无权限 */ }
    }
  } catch {
    return 0; // /proc 不可用
  }

  const underWorkDir = (cwd: string) =>
    cwd === canonicalWorkDir || cwd.startsWith(canonicalWorkDir + '/');

  // 目标根进程：优先 SDK 直接派生的 CLI（父进程是本网关进程）
  const roots = new Set<number>();
  for (const [pid, info] of procs) {
    if (underWorkDir(info.cwd) && info.ppid === process.pid) roots.add(pid);
  }
  // 兜底：进程被孤儿化（如网关自身重启过）时，匹配所有 cwd 在工作目录下的进程
  if (roots.size === 0) {
    for (const [pid, info] of procs) {
      if (underWorkDir(info.cwd)) roots.add(pid);
    }
  }
  if (roots.size === 0) return 0;

  // 收集每个根进程的整棵子树
  const children = new Map<number, number[]>();
  for (const [pid, info] of procs) {
    const list = children.get(info.ppid) ?? [];
    list.push(pid);
    children.set(info.ppid, list);
  }
  const toKill = new Set<number>();
  for (const root of roots) {
    toKill.add(root);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const child of children.get(cur) ?? []) {
        if (!toKill.has(child)) {
          toKill.add(child);
          queue.push(child);
        }
      }
    }
  }

  let killed = 0;
  for (const pid of toKill) {
    try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* 已退出 */ }
  }
  return killed;
}
