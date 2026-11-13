import pino from 'pino';
import { join } from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

// 真正生效的 logger。initLogger() 前为 null，之后指向重建的 pino 实例。
// 注意：不能用同一个变量既存 proxy 又存真实 logger，否则 proxy 的 get trap
// 会读到自己，导致无限递归（Maximum call stack size exceeded）。
let realLogger: pino.Logger | null = null;

// 初始化前的占位 logger（info 级别、仅 stdout）。
// 各模块在 import 阶段就会执行 `const log = getLogger()`，此时 initLogger 尚未运行；
// 直接返回这个 fallback 会导致模块永远持有 fallback，拿不到之后重建的 logger。
const fallback = pino({ level: 'info' });

// 通过 Proxy 把每次方法调用转发给”当前”的 logger，
// 因此模块顶层持有的 log 引用在 initLogger() 重建后依然指向新实例。
function createLazyLogger(): pino.Logger {
  return new Proxy(fallback, {
    get(target, prop) {
      const actual = realLogger ?? target;
      const value = Reflect.get(actual, prop, actual);
      if (typeof value === 'function') {
        return value.bind(actual);
      }
      return value;
    },
  }) as pino.Logger;
}

export function initLogger(dataDir: string, debug = false, logRolledCount = 30) {
  const level = debug ? 'debug' : 'info';
  const logDir = join(dataDir, 'logs');
  const logFile = join(logDir, 'app');

  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino-roll',
      options: {
        file: logFile,
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        extension: 'log',
        mkdir: true,
        // 最多保留 logRolledCount 个本进程产生的滚动文件（不包括旧日期的 .gz）
        limit: { count: logRolledCount },
      },
      level,
    },
    {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss' },
      level,
    },
  ];

  realLogger = pino(
    { level, mixin: () => ({ datetime: fmtDatetime() }) },
    pino.transport({ targets }),
  );
  return realLogger;
}

/** 人类可读的 YYYY-MM-DD HH:mm:ss 时间戳 */
function fmtDatetime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function getLogger(): pino.Logger {
  if (!realLogger) {
    // 尚未初始化：返回懒代理，后续 initLogger 生效后自动指向新实例
    return createLazyLogger();
  }
  return realLogger;
}

// 当日滚动文件格式：app.yyyy-MM-dd.<n>.log（由 pino-roll 生成）。
// 滚动后文件不再被写入，这里压缩成 app.yyyy-MM-dd.<n>.log.gz 并删除原文件。
const ROLLED_FILE_RE = /^app\.\d{4}-\d{2}-\d{2}\.\d+\.log$/;
const GZ_FILE_RE = /^app\.\d{4}-\d{2}-\d{2}\.\d+\.log\.gz$/;

/** 压缩昨天（含更早）已滚动完成的日志，并清理过量的 .gz 文件 */
export async function compressLogs(logDir: string, maxGzFiles = 60) {
  const today = fmtDate(new Date());
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return;
  }

  const gzFiles = entries.filter(n => GZ_FILE_RE.test(n)).sort();

  // 压缩已滚动的旧日志（排除今天的活跃文件）
  for (const name of entries) {
    if (!ROLLED_FILE_RE.test(name)) continue;
    const date = name.slice(4, 14); // app.yyyy-MM-dd.<n>.log → yyyy-MM-dd
    if (date >= today) continue;
    const gzName = `${name}.gz`;
    if (gzFiles.includes(gzName)) {
      // 已压缩，删除残留原文件
      await safeUnlink(join(logDir, name));
      continue;
    }
    await compressFile(join(logDir, name));
  }

  // 清理超出保留数量的 .gz 文件（按文件名排序，保留最新的）
  const refreshed = (await readdir(logDir).catch(() => [] as string[]))
    .filter(n => GZ_FILE_RE.test(n)).sort();
  for (let i = 0; i < refreshed.length - maxGzFiles; i++) {
    await safeUnlink(join(logDir, refreshed[i]));
  }
}

async function compressFile(filePath: string) {
  try {
    const gzPath = `${filePath}.gz`;
    await pipeline(
      createReadStream(filePath),
      createGzip({ level: 6 }),
      createWriteStream(gzPath, { flags: 'wx' }),
    );
    await safeUnlink(filePath);
  } catch {
    // 压缩失败不致命，下次周期会重试；wx 标志避免覆盖已有 .gz
  }
}

async function safeUnlink(path: string) {
  try {
    await unlink(path);
  } catch {
    // 文件可能已被并发清理
  }
}

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
