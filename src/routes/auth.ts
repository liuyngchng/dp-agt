import { Router, Request, Response } from 'express';
import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { usersStore, configStore, hashPasswordSync, comparePasswordSync } from '../store.js';
import { getLogger } from '../logger.js';

const log = getLogger();

// Token 有效期：持久化密钥 7 天，临时密钥 2h
const LONG_TTL = 7 * 24 * 3600;
const SHORT_TTL = 2 * 3600;
const MUST_CHANGE_PWD_WINDOW = 2 * 3600; // 2h 内必须改密码

// 模块级缓存：确保同一进程内密钥一致（容器重启则重新生成）
let _cachedSecret: { secret: Buffer; temporary: boolean } | null = null;

// ============================================================
// Token 签名密钥管理
// ============================================================
function getOrCreateSecret(): { secret: Buffer; temporary: boolean } {
  if (_cachedSecret) return _cachedSecret;

  const persisted = configStore.get('token_secret');
  if (persisted) {
    _cachedSecret = { secret: Buffer.from(persisted, 'hex'), temporary: false };
    return _cachedSecret;
  }
  // 临时密钥（2h 有效），admin 改密码后持久化
  const random = randomBytes(32);
  log.warn({}, 'auth_auto_generated_key — 使用临时随机密钥（token 2h 有效），admin 修改密码后自动持久化');
  _cachedSecret = { secret: random, temporary: true };
  return _cachedSecret;
}

export function persistSecret() {
  const { secret, temporary } = getOrCreateSecret();
  if (temporary) {
    configStore.set('token_secret', secret.toString('hex'), 'admin 改密后持久化的 token 签名密钥');
    // 更新缓存，后续请求用持久化的密钥
    _cachedSecret = { secret, temporary: false };
    log.info({}, 'auth_key_persisted — admin 修改密码后，临时密钥已持久化到数据库');
  }
}

// ============================================================
// Token 工具
// ============================================================
interface TokenPayload {
  uid: number;
  uname: string;
  role: number;
  /** 签发时的 user_version，校验时与 DB 当前值比对，不匹配则 token 失效 */
  uv: number;
  exp: number;
  salt: string;
}

function signToken(userId: number, username: string, role: number, userVersion: number, secret: Buffer, temporary: boolean): string {
  const ttl = temporary ? SHORT_TTL : LONG_TTL;
  const payload: TokenPayload = {
    uid: userId,
    uname: username,
    role,
    uv: userVersion,
    exp: Math.floor(Date.now() / 1000) + ttl,
    salt: randomBytes(6).toString('hex'),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('hex');
  const mac = createHmac('sha256', secret).update(data).digest('hex').slice(0, 16);
  return data + '.' + mac;
}

function verifyToken(token: string, secret: Buffer): TokenPayload | null {
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const data = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = createHmac('sha256', secret).update(data).digest('hex').slice(0, 16);
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(data, 'hex').toString('utf8'));
  } catch {
    return null;
  }

  if (Date.now() / 1000 > payload.exp) return null;

  // 校验 user_version：与 DB 当前值比对，不匹配则 token 已被改密/登出作废
  const user = usersStore.get(payload.uname);
  if (!user || user.user_version !== payload.uv) return null;

  return payload;
}

// ============================================================
// 密码强度校验：至少 8 位，同时包含字母和数字
// ============================================================
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return '密码长度至少 8 位';
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasLetter) return '密码必须包含字母';
  if (!hasDigit) return '密码必须包含数字';
  return null;
}

// ============================================================
// 从 Cookie / Authorization 中提取并验证用户
// ============================================================
function getUserFromCookie(req: Request): TokenPayload | null {
  const token = req.cookies?.auth_token;
  if (!token) return null;
  const { secret } = getOrCreateSecret();
  return verifyToken(token, secret);
}

function getUserFromBearer(req: Request): TokenPayload | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const { secret } = getOrCreateSecret();
  return verifyToken(token, secret);
}

// ============================================================
// 中间件
// ============================================================

/** Web 页面认证中间件（Cookie，未登录跳转 /login） */
export function authWebMiddleware(req: Request, res: Response, next: () => void) {
  const user = getUserFromCookie(req);
  if (!user) {
    // API 请求返回 JSON，页面请求重定向
    if (req.path.startsWith('/admin/') || req.path.startsWith('/api/inner/')) {
      res.status(401).json({ error: '请先登录' });
    } else {
      res.redirect('/login');
    }
    return;
  }
  (req as unknown as Record<string, unknown>).user = user;
  next();
}

/** API 认证中间件（Cookie 或 Bearer，返回 JSON） */
export function authApiMiddleware(req: Request, res: Response, next: () => void) {
  let user = getUserFromCookie(req);
  if (!user) user = getUserFromBearer(req);
  if (!user) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  (req as unknown as Record<string, unknown>).user = user;
  next();
}

/** Admin 权限中间件 */
export function adminOnlyMiddleware(req: Request, res: Response, next: () => void) {
  const user = (req as unknown as Record<string, unknown>).user as TokenPayload | undefined;
  if (!user || user.role !== 1) {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

/**
 * 对外访问路径鉴权中间件。
 * 仅从 DB 配置（系统设置 → 对外 API 认证）读取 token。
 * 两种认证方式：
 *   1. X-Api-Key: {token}
 *   2. Authorization: Bearer {token}
 *
 * 若 DB 中未启用（api_auth_enabled !== '1'），直接放行。
 */
/** 对外 API 认证 token 的 SHA-256 十六进制哈希（DB 只存哈希，不存明文） */
function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 对外 API 认证中间件。
 * 支持两种携带方式：
 *   1. X-Api-Key: {token}
 *   2. Authorization: Bearer {token}
 *
 * 若 DB 中未启用（api_auth_enabled !== '1'），直接放行。
 * token 在 DB 中仅存 SHA-256 哈希，比较使用 timingSafeEqual 防时序侧信道。
 */
export function apiTokenMiddleware() {
  return (req: Request, res: Response, next: () => void) => {
    log.debug({ path: req.path, body: req.body }, 'api_request_received');

    const dbEnabled = configStore.get('api_auth_enabled');
    const dbTokenHash = configStore.get('api_auth_token');

    const respondUnauthorized = (reason: string) => {
      const resp = {
        code: 1003,
        message: 'Unauthorized: 无效或缺失的 X-Api-Key / Authorization Bearer Token',
        task_id: '',
        linkid: '',
      };
      // 记录校验失败日志：含来源 IP、路径、原因，但不记录 token 明文/哈希
      log.warn({
        path: req.path,
        ip: req.ip || req.socket?.remoteAddress || '-',
        reason,
        has_token: !!extractToken(req),
      }, 'api_auth_failed');
      res.status(401).json(resp);
    };

    // DB 启用 → 校验 token
    if (dbEnabled === '1' && dbTokenHash) {
      const token = extractToken(req);
      if (!token) {
        respondUnauthorized('missing_token');
        return;
      }
      const providedHash = hashApiToken(token);
      // timingSafeEqual 要求两 buffer 等长；哈希长度固定为 64，安全
      let ok = false;
      try {
        ok = timingSafeEqual(
          Buffer.from(providedHash, 'hex'),
          Buffer.from(dbTokenHash, 'hex'),
        );
      } catch {
        ok = false;
      }
      if (!ok) {
        respondUnauthorized('token_mismatch');
        return;
      }
    }

    // 未启用或未配置 → 放行
    next();
  };
}

/** 从 X-Api-Key 或 Authorization: Bearer 中提取 token */
function extractToken(req: Request): string | null {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey) return apiKey;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

/** 从请求上下文获取当前用户 */
export function getCurrentUser(req: Request): TokenPayload | undefined {
  return (req as unknown as Record<string, unknown>).user as TokenPayload | undefined;
}

// ============================================================
// 路由
// ============================================================
export function createAuthRouter(): Router {
  const router = Router();

  // POST /api/login
  router.post('/api/login', (req: Request, res: Response) => {
    const { user_name, user_pwd } = (req.body ?? {}) as Record<string, string>;
    if (!user_name || !user_pwd) {
      res.status(400).json({ error: '用户名和密码不能为空' });
      return;
    }

    const user = usersStore.get(user_name);
    if (!user) {
      log.warn({ username: user_name }, 'auth_login_user_not_found');
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    if (!comparePasswordSync(user_pwd, user.password_hash)) {
      log.warn({ username: user_name }, 'auth_login_wrong_password');
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    // admin 首次登录：2h 内未修改则初始密码失效
    if (user.must_change_pwd) {
      // 优先用 created_ts（Unix 毫秒），否则回退解析 created_at
      const createdSec = user.created_ts
        ? user.created_ts / 1000
        : new Date(user.created_at).getTime() / 1000;
      if (Date.now() / 1000 - createdSec > MUST_CHANGE_PWD_WINDOW) {
        log.warn({ username: user_name }, 'auth_must_change_pwd_expired');
        res.status(403).json({ error: '初始密码已过期（2小时内未修改），请联系管理员重置' });
        return;
      }
    }

    const { secret, temporary } = getOrCreateSecret();
    const token = signToken(user.id, user.username, user.role, user.user_version, secret, temporary);

    // Set httpOnly cookie
    const ttl = temporary ? SHORT_TTL : LONG_TTL;
    res.cookie('auth_token', token, {
      httpOnly: true,
      maxAge: ttl * 1000,
      path: '/',
      sameSite: 'lax',
    });

    log.info({ user: user.username }, 'user_login');

    res.json({
      status: 'ok',
      token,
      must_change_pwd: !!user.must_change_pwd,
      user: { id: user.id, username: user.username, role: user.role },
    });
  });

  // POST /api/logout — 递增 user_version 使所有旧 token 失效
  router.post('/api/logout', (req: Request, res: Response) => {
    const tokenPayload = getUserFromCookie(req) || getUserFromBearer(req);
    if (tokenPayload) {
      usersStore.incrementUserVersion(tokenPayload.uname);
      log.info({ user: tokenPayload.uname }, 'user_logout_and_tokens_invalidated');
    }
    res.clearCookie('auth_token', { path: '/' });
    res.json({ status: 'ok' });
  });

  // GET /api/inner/whoami — 前端探活，无副作用
  router.get('/api/inner/whoami', authApiMiddleware, (req: Request, res: Response) => {
    const cu = getCurrentUser(req);
    res.json({ code: 0, data: { id: cu!.uid, username: cu!.uname, role: cu!.role } });
  });

  // PUT /api/inner/user/password — 修改密码
  router.put('/api/inner/user/password', authApiMiddleware, (req: Request, res: Response) => {
    const { old_pwd, new_pwd } = (req.body ?? {}) as Record<string, string>;
    if (!new_pwd) {
      res.status(400).json({ error: '参数错误' });
      return;
    }

    const strengthErr = validatePasswordStrength(new_pwd);
    if (strengthErr) {
      res.status(400).json({ error: '新密码: ' + strengthErr });
      return;
    }

    const cu = getCurrentUser(req);
    if (!cu) {
      res.status(401).json({ error: '请先登录' });
      return;
    }

    const user = usersStore.get(cu.uname);
    if (!user) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    // 验证旧密码（跳过 admin 首次修改的场景）
    if (old_pwd) {
      if (!comparePasswordSync(old_pwd, user.password_hash)) {
        res.status(400).json({ error: '旧密码错误' });
        return;
      }
    }

    const hash = hashPasswordSync(new_pwd);
    usersStore.updatePassword(cu.uname, hash);
    usersStore.clearMustChangePwd(cu.uname);

    // admin 改密后持久化密钥
    persistSecret();

    log.info({ user: cu.uname }, 'user_password_changed');
    res.json({ status: 'ok' });
  });

  return router;
}