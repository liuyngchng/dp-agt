// === VERSION: 2025-07-17-debug-sessions ===
const API = '/admin';

// ============================================================
// 全局 fetch 包装：统一处理 401 未登录 → 跳转登录页
// ============================================================
const _nativeFetch = window.fetch.bind(window);
window.fetch = async function(...args) {
    try {
        const resp = await _nativeFetch(...args);
        if (resp.status === 401) {
            redirectToLogin();
            throw new Error('未登录或登录已过期');
        }
        return resp;
    } catch (err) {
        // 网络错误也走这里，但登录页本身除外
        if (err && err.message === '未登录或登录已过期') throw err;
        throw err;
    }
};

let _loginRedirecting = false;
function redirectToLogin() {
    if (_loginRedirecting) return;
    _loginRedirecting = true;
    window.location.href = '/login';
}

// ============================================================
// 闲置超时自动登出（默认 30 分钟无操作）
// ============================================================
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
let _idleTimer = null;
function resetIdleTimer() {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
        doLogout();
    }, IDLE_TIMEOUT_MS);
}
['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach(evt =>
    document.addEventListener(evt, resetIdleTimer, { passive: true })
);
resetIdleTimer();

// ==== 根据后端 nav 渲染侧边栏 + 绑定事件 ====
async function initNav() {
    try {
        const res = await fetch(API + '/nav');
        const json = await res.json();
        const tabs = json.data?.tabs || [];
        const defaultTab = json.data?.default_tab || 'audit';

        const sidebar = document.getElementById('cfgSidebar');
        sidebar.innerHTML = tabs.map(t =>
            `<div class="cfg-tab" data-tab="${t.id}">
                <i class="fas ${t.icon}"></i> ${t.label}
            </div>`
        ).join('');

        // 绑定 tab 点击
        sidebar.querySelectorAll('.cfg-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                sidebar.querySelectorAll('.cfg-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('.cfg-section').forEach(s => s.classList.remove('active'));
                const section = document.getElementById('section-' + tab.dataset.tab);
                if (section) section.classList.add('active');
                if (tab.dataset.tab === 'interfaces') { loadInterfaces(); loadConfigKeys(); loadPreview(); }
                else if (tab.dataset.tab === 'memory') loadMemories();
                else if (tab.dataset.tab === 'simulate') loadSimulateTab();
                else if (tab.dataset.tab === 'tasks') loadTasks();
                else if (tab.dataset.tab === 'sys') loadSysConfig();
                else if (tab.dataset.tab === 'users') loadUsers();
                else if (tab.dataset.tab === 'audit') loadAudit(0);
                else if (tab.dataset.tab === 'sessions') loadSessions();
            });
        });

        // 激活默认 tab
        const defaultEl = sidebar.querySelector('[data-tab="' + defaultTab + '"]');
        if (defaultEl) defaultEl.click();
    } catch (_) {}
}

// backward compat: old querySelectorAll removed, replaced by initNav above
// stub kept for manual window.onload — called at bottom

// ==== Toast ====
function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'cfg-toast ' + (type || 'success');
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ==== Modal helpers ====
function closeTaskModal() { document.getElementById('taskModal').classList.remove('show'); }

// ==== Interfaces ====
async function loadInterfaces() {
    const res = await fetch(API + '/interfaces');
    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : [];
    const tbody = document.getElementById('ifacesTbody');
    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;padding:24px;">暂无访问路径</td></tr>';
        return;
    }
    tbody.innerHTML = list.map((i, idx) => {
        const name = escHtml(i.name);
        const path = escHtml(i.path);
        const ts = fmtTs(i.updated_at);
        return `<tr>
            <td class="col-seq">${idx + 1}</td>
            <td>${name}</td>
            <td>${path}</td>
            <td>${ts}</td>
        </tr>`;
    }).join('');
}

// ==== 记忆管理 ====
async function loadMemories() {
    try {
        const res = await fetch(API + '/memory');
        const json = await res.json();
        const items = (json.data && json.data.items) || [];
        const tbody = document.getElementById('memoryTbody');
        if (items.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:24px;">暂无记忆文件，请上传业务知识文档</td></tr>';
            return;
        }
        tbody.innerHTML = items.map((m, idx) => `<tr>
            <td class="col-seq">${idx + 1}</td>
            <td><span style="font-family:monospace;font-size:0.85rem;">${escHtml(m.filename)}</span></td>
            <td>${escHtml(m.title)}</td>
            <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(m.description || '')}">${escHtml(m.description || '-')}</td>
            <td>${fmtSize(m.size)}</td>
            <td class="col-action">
                <button class="cfg-btn-sm cfg-btn-icon cfg-btn-icon-primary" onclick="previewMemory('${escJs(m.filename)}')" title="预览" style="margin-right:4px;"><i class="fas fa-eye"></i></button>
                <button class="cfg-btn-danger-sm" onclick="deleteMemoryFile('${escJs(m.filename)}')" title="删除"><i class="fas fa-trash-alt"></i></button>
            </td>
        </tr>`).join('');
    } catch (err) {
        document.getElementById('memoryTbody').innerHTML = '<tr><td colspan="6" style="text-align:center;color:#e53e3e;padding:24px;">加载失败: ' + escHtml(err.message) + '</td></tr>';
    }
}

function fmtSize(bytes) {
    if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

async function uploadMemory() {
    const input = document.getElementById('memoryFileInput');
    const file = input.files[0];
    if (!file) return toast('请选择 .md / .tar.gz / .tgz / .zip 文件', 'error');

    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(API + '/memory/upload', { method: 'POST', body: fd });
    const json = await res.json();
    const resultEl = document.getElementById('memoryResult');
    if (json.code !== 0) {
        resultEl.innerHTML = '<span style="color:#e53935;">✗ ' + escHtml(json.message || '上传失败') + '</span>';
        return;
    }
    resultEl.innerHTML = '<span style="color:#2e7d32;">✓ 已上传 ' + json.data.total + ' 个文件: ' + escHtml((json.data.files || []).join(', ')) + '</span>';
    toast('记忆文件已上传');
    loadMemories();
}

async function previewMemory(filename) {
    try {
        const res = await fetch(API + '/memory/' + encodeURIComponent(filename) + '/content');
        const json = await res.json();
        if (json.code !== 0) {
            toast(json.message || '获取失败', 'error');
            return;
        }
        document.getElementById('memoryModalTitle').innerHTML = '<i class="fas fa-file-alt"></i> ' + escHtml(filename);
        document.getElementById('memoryContent').textContent = json.data.content || '';
        document.getElementById('memoryModal').classList.add('show');
    } catch (err) {
        toast('预览失败: ' + err.message, 'error');
    }
}

function closeMemoryModal() {
    document.getElementById('memoryModal').classList.remove('show');
}

async function deleteMemoryFile(filename) {
    if (!confirm('确定删除记忆文件 ' + filename + '？\\n删除后下一个新任务将不再能查到此知识。')) return;
    try {
        const res = await fetch(API + '/memory/' + encodeURIComponent(filename), { method: 'DELETE' });
        const json = await res.json();
        if (json.code !== 0) {
            toast(json.message || '删除失败', 'error');
            return;
        }
        toast('已删除', 'success');
        loadMemories();
    } catch (err) {
        toast('删除失败: ' + err.message, 'error');
    }
}

function escJs(s) {
    if (!s) return '';
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ==== 模板管理（CSV / Tar / 预览） ====

// 下载 CSV 模板
function downloadCsvTemplate() {
    window.location.href = API + '/prompt-config/template';
}

// 上传 CSV
async function uploadCsv() {
    const input = document.getElementById('csvFileInput');
    const file = input.files[0];
    if (!file) return toast('请选择 CSV 文件', 'error');

    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(API + '/prompt-config/upload-csv', { method: 'POST', body: fd });
    const json = await res.json();
    if (json.code !== 0) {
        document.getElementById('csvResult').innerHTML = `<span style="color:#e53935;">✗ ${escHtml(json.message || '上传失败')}</span>`;
        return;
    }
    const keys = json.data.keys || [];
    document.getElementById('csvResult').innerHTML = `<span style="color:#2e7d32;">✓ 已导入 ${json.data.imported} 个配置项</span>`;
    // 刷新 key 列表
    await loadConfigKeys();
    // 启用步骤 2
    document.getElementById('wizardStep2').style.opacity = '1';
    document.getElementById('wizardStep2').querySelector('.wizard-dot').style.background = '#1565c0';
    toast('CSV 配置已导入');
}

// 加载配置 key 列表
async function loadConfigKeys() {
    const res = await fetch(API + '/prompt-config');
    const json = await res.json();
    const rows = (json.data && json.data.rows) || [];
    const wrap = document.getElementById('configKeysWrap');
    const table = document.getElementById('configKeysTable');
    if (rows.length === 0) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'block';

    // 先获取明文（供敏感项切换用）
    let revealMap = {};
    try {
        const rr = await fetch(API + '/prompt-config?reveal=1');
        const rj = await rr.json();
        const rrows = (rj.data && rj.data.rows) || [];
        rrows.forEach(r => { revealMap[r.key] = r.value; });
    } catch {}

    let html = '<table class="result-table" style="font-size:0.85rem;">';
    html += '<thead><tr><th>Key</th><th>值</th><th>说明</th></tr></thead><tbody>';
    rows.forEach((r, idx) => {
        const key = escHtml(r.key);
        const note = escHtml(r.note || '-');
        const uid = 'val-' + idx;
        if (r.is_secret) {
            html += '<tr><td><code>' + key + '</code></td>'
                + '<td class="val-cell"><span class="val-text" id="' + uid + '" title="' + escHtml(r.value) + '">' + escHtml(r.value) + '</span> '
                + '<button class="cfg-btn-sm eye-btn" data-idx="' + idx + '" data-key="' + key + '"><i class="fas fa-eye"></i></button></td>'
                + '<td>' + note + '</td></tr>';
        } else {
            html += '<tr><td><code>' + key + '</code></td>'
                + '<td class="val-cell"><span class="val-text" title="' + escHtml(r.value) + '">' + escHtml(r.value) + '</span></td>'
                + '<td>' + note + '</td></tr>';
        }
    });
    html += '</tbody></table>';
    table.innerHTML = html;

    // 事件委托：眼睛按钮
    table.querySelectorAll('.eye-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.dataset.idx);
            const key = this.dataset.key;
            const span = document.getElementById('val-' + idx);
            if (!span) return;
            if (span.dataset.revealed === '1') {
                // 切回脱敏
                span.textContent = rows[idx].value;
                span.title = rows[idx].value;
                span.dataset.revealed = '0';
                this.innerHTML = '<i class="fas fa-eye"></i>';
            } else {
                // 切到明文
                const plain = revealMap[key] || rows[idx].value;
                span.textContent = plain;
                span.title = plain;
                span.dataset.revealed = '1';
                this.innerHTML = '<i class="fas fa-eye-slash"></i>';
            }
        });
    });
}

// 上传 Tar
async function uploadTar() {
    const input = document.getElementById('tarFileInput');
    const file = input.files[0];
    if (!file) return toast('请选择 .tar / .tar.gz / .tgz / .zip 文件', 'error');

    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(API + '/prompt-tar/upload', { method: 'POST', body: fd });
    const json = await res.json();
    const resultEl = document.getElementById('tarResult');
    if (json.code !== 0) {
        let html = `<span style="color:#e53935;">✗ ${escHtml(json.message || '上传失败')}</span>`;
        if (json.data && json.data.errors && json.data.errors.length) {
            html += '<ul style="margin-top:8px;color:#e53935;">' + json.data.errors.map(e => `<li>${escHtml(e)}</li>`).join('') + '</ul>';
        }
        resultEl.innerHTML = html;
        return;
    }
    resultEl.innerHTML = `<span style="color:#2e7d32;">✓ 已上传 ${json.data.total} 个文件</span>`;
    if (json.data.warnings && json.data.warnings.length) {
        resultEl.innerHTML += '<ul style="margin-top:8px;color:#e65100;">' + json.data.warnings.map(w => `<li>⚠ ${escHtml(w)}</li>`).join('') + '</ul>';
    }
    // 启用步骤 3
    document.getElementById('wizardStep3').style.opacity = '1';
    document.getElementById('wizardStep3').querySelector('.wizard-dot').style.background = '#1565c0';
    toast('Prompt 文件包已上传');
    await loadPreview();
}

// 下载 tar
function downloadTar() {
    window.location.href = API + '/prompt-tar/download';
}

// 加载预览
async function loadPreview() {
    const res = await fetch(API + '/prompt-preview');
    const json = await res.json();
    const previews = (json.data && json.data.previews) || [];
    const wrap = document.getElementById('previewWrap');
    const container = document.getElementById('previewFiles');
    if (previews.length === 0) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'block';
    container.innerHTML = previews.map(p => `
        <details style="border:1px solid #e0e0e0;border-radius:6px;padding:8px 12px;background:#fff;">
            <summary style="cursor:pointer;font-weight:600;color:#333;">${escHtml(p.file)}</summary>
            <pre style="margin:12px 0 0;padding:12px;background:#f5f5f5;border-radius:6px;font-size:0.8rem;font-family:'SF Mono','Consolas',monospace;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;">${escHtml(p.raw)}</pre>
        </details>
    `).join('');
}

// ==== Tasks (server-side pagination) ====
const TASKS_PAGE_SIZE = 10;
let _tasksPage = 1;
let _tasksTotal = 0;

async function loadTasks(page = 1) {
    _tasksPage = page;
    const res = await fetch(API + '/tasks?page=' + page + '&page_size=' + TASKS_PAGE_SIZE);
    const json = await res.json();
    const data = json.data || {};
    const list = Array.isArray(data.items) ? data.items : [];
    _tasksTotal = data.total || 0;
    renderTasksPage(list);
}

function renderTasksPage(list) {
    const total = _tasksTotal;
    const totalPages = Math.max(1, Math.ceil(total / TASKS_PAGE_SIZE));
    const tbody = document.getElementById('tasksTbody');
    if (total === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;padding:24px;">暂无任务</td></tr>';
        document.getElementById('tasksPager').innerHTML = '';
        return;
    }
    const start = (_tasksPage - 1) * TASKS_PAGE_SIZE;
    tbody.innerHTML = list.map((t, i) => {
        const no = start + i + 1;
        const rid = 'trow-' + no;
        const taskId = escHtml(t.task_id);
        const title = t.title || '-';
        const titleDisplay = title.length > 20 ? escHtml(title.substring(0, 20)) + '...' : escHtml(title);
        return `<tr class="main-row">
            <td class="col-seq">${no}</td>
            <td class="col-title"><span title="${escHtml(title)}" onclick="toggleRowDetail('${rid}')" style="cursor:pointer;color:#4b6cb7;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:4px;">${titleDisplay}</span></td>
            <td>${escHtml(t.path || '-')}</td>
            <td><code style="font-size:0.78rem;">${escHtml((t.linkid || '-').substring(0,8))}...</code></td>
            <td>${statusText(t.status)}</td>
            <td class="col-date">${fmtTs(t.created_at)}</td>
            <td class="col-date">${fmtTs(t.finished_at)}</td>
            <td class="col-action"><button class="cfg-btn-sm cfg-btn-icon cfg-btn-icon-primary" onclick="viewSession('${escHtml(t.session_id || '')}', '${taskId}', '${escHtml(t.status || '')}')" title="会话记录"><i class="fas fa-comments"></i></button></td>
        </tr>
        <tr class="row-detail" id="${rid}" style="display:none;">
            <td colspan="8" style="padding:4px 12px 8px;font-size:0.82rem;color:#555;user-select:text;">
                <span class="audit-info-label">Task ID:</span> ${taskId}
                &nbsp;&nbsp;&nbsp;
                <span class="audit-info-label">LinkID:</span> ${escHtml(t.linkid || '-')}
            </td>
        </tr>`;
    }).join('');
    document.getElementById('tasksPager').innerHTML = pagerHtml(_tasksPage, totalPages, 'loadTasks');
}

async function viewTask(taskId) {
    const res = await fetch(API + '/tasks/' + encodeURIComponent(taskId));
    const json = await res.json();
    const t = json.data;
    if (!t) return toast('未找到', 'error');

    document.getElementById('taskDetail').innerHTML = taskDetailHtml(t);
    document.getElementById('taskModal').classList.add('show');
}

function taskDetailHtml(t) {
    let step = 0;
    const errMsg = t.error_message || '';
    // 信息头 — 固定不动
    let html = '<div class="task-info-bar" style="flex-shrink:0;">' +
        '<div class="task-info-row"><span class="task-info-label">标题：</span>' + escHtml(t.title || '-') + '</div>' +
        '<div class="task-info-row"><span class="task-info-label">Task ID：</span>' + escHtml(t.task_id) + '<span class="task-info-label" style="margin-left:8px;">LinkID：</span>' + escHtml(t.linkid || '-') + '<span class="task-info-label" style="margin-left:8px;">Session：</span>' + escHtml((t.session_id || '-').substring(0,8)) + '</div>' +
        '<div class="task-info-row"><span class="task-info-label">访问路径：</span>' + escHtml(t.path || '-') + '<span class="task-info-label" style="margin-left:8px;">状态：</span>' + statusText(t.status) + '</div>' +
        '<div class="task-info-row"><span class="task-info-label">创建：</span>' + fmtTs(t.created_at) + '<span class="task-info-label" style="margin-left:8px;">完成：</span>' + fmtTs(t.finished_at) + '</div>' +
        (errMsg ? '<div class="task-info-row" style="color:#c62828;"><span class="task-info-label">错误信息：</span>' + escHtml(errMsg) + '</div>' : '') +
        '</div>';
    // 折叠区 — 可滚动
    html += '<div class="task-steps-scroll" style="flex:1;min-height:0;overflow-y:auto;padding-top:12px;">';
    html += '<div class="kv-section" onclick="toggleTaskDetail(this)" style="cursor:pointer;"><i class="fas fa-arrow-right"></i> ' + (++step) + '. 请求体 <i class="fas fa-chevron-right task-detail-toggle" style="margin-left:auto;color:#999;font-size:0.75rem;"></i></div>';
    html += '<div class="task-detail-json term-box" style="display:none;">' + escHtml(jsonFmt(t.request_body)) + '</div>';
    html += '<div class="kv-section" onclick="toggleTaskDetail(this)" style="cursor:pointer;"><i class="fas fa-arrow-left"></i> ' + (++step) + '. 请求体返回 <i class="fas fa-chevron-right task-detail-toggle" style="margin-left:auto;color:#999;font-size:0.75rem;"></i></div>';
    html += '<div class="task-detail-json term-box" style="display:none;">' + escHtml(jsonFmt(t.request_response)) + '</div>';
    html += '<div class="kv-section" onclick="toggleTaskDetail(this)" style="cursor:pointer;"><i class="fas fa-arrow-right"></i> ' + (++step) + '. 提示词 <i class="fas fa-chevron-right task-detail-toggle" style="margin-left:auto;color:#999;font-size:0.75rem;"></i></div>';
    html += '<div class="task-detail-json term-box" style="display:none;">' + escHtml(t.prompt || '(未记录)') + '</div>';
    html += '<div class="kv-section" onclick="toggleTaskDetail(this)" style="cursor:pointer;"><i class="fas fa-arrow-right"></i> ' + (++step) + '. Agent 输出 <i class="fas fa-chevron-right task-detail-toggle" style="margin-left:auto;color:#999;font-size:0.75rem;"></i></div>';
    html += '<div class="task-detail-json term-box" style="display:none;">' + escHtml(t.sdk_output || '(未记录)') + '</div>';
    html += '</div>';
    return html;
}

// ==============================
document.getElementById('auditDetailModal').addEventListener('click', function(e) { if (e.target === this) closeAuditDetail(); });
document.getElementById('streamModal').addEventListener('click', function(e) { if (e.target === this) closeStreamModal(); });
document.getElementById('chatModal').addEventListener('click', function(e) { if (e.target === this) closeChatModal(); });
document.getElementById('memoryModal').addEventListener('click', function(e) { if (e.target === this) closeMemoryModal(); });

// Init
initNav();
loadSysConfig();

// ==== Utilities ====
function escHtml(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTs(s) { if (!s) return '-'; /* 数据库 created_at / finished_at 为 ISO，格式化为秒 */ try { const d = new Date(s); if (isNaN(d.getTime())) return s; const p = (n) => String(n).padStart(2,'0'); return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); } catch { return s; } }
/** 时间线用：保留毫秒。已格式化的时间直接返回，否则从 ISO 转换 */
function fmtTimelineTs(s) { if (!s) return ''; if (/^\d{2}:\d{2}:\d{2}/.test(s)) return s; /* 旧 HH:MM:ss.SSS */ if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s; /* 已是 YYYY-MM-DD HH:MM:ss(.SSS) */ try { const d = new Date(s); if (isNaN(d.getTime())) return s; const p = (n) => String(n).padStart(2,'0'); return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3,'0'); } catch { return s; } }
function jsonFmt(v) { if (typeof v === 'string') try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } return JSON.stringify(v, null, 2); }
function statusText(s) {
    const map = {
        pending: '排队中',
        processing: '处理中',
        failed: '失败',
        completed: '已完成',
        cancelled: '已取消',
    };
    return map[s] || s || '-';
}

// Close modal on overlay click
document.getElementById('taskModal').addEventListener('click', function(e) { if (e.target === this) closeTaskModal(); });
document.getElementById('streamModal').addEventListener('click', function(e) { if (e.target === this) closeStreamModal(); });

// Close modal on ESC
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        if (document.getElementById('taskModal').classList.contains('show')) closeTaskModal();
        if (document.getElementById('streamModal').classList.contains('show')) closeStreamModal();
        if (document.getElementById('auditDetailModal').classList.contains('show')) closeAuditDetail();
        if (document.getElementById('memoryModal').classList.contains('show')) closeMemoryModal();
    }
});

// 终端黑框：鼠标悬停时 Ctrl+A 全选框内、Ctrl+C 复制框内
function selectTermBox(box) {
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

// 追踪当前鼠标悬停的终端框（keydown 的 e.target 是焦点元素，不代表鼠标位置）
let _hoveredTermBox = null;
document.addEventListener('mouseover', function(e) {
    _hoveredTermBox = e.target.closest('.term-box');
});
document.addEventListener('mouseout', function(e) {
    const box = e.target.closest('.term-box');
    if (box && !box.contains(e.relatedTarget)) _hoveredTermBox = null;
});

document.addEventListener('keydown', function(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    const box = _hoveredTermBox;
    if (!box) return;

    if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        selectTermBox(box);
        return;
    }

    if (e.key === 'c' || e.key === 'C') {
        const sel = window.getSelection();
        const hasSelection = sel && !sel.isCollapsed &&
            box.contains(sel.anchorNode) && box.contains(sel.focusNode);
        if (!hasSelection) {
            e.preventDefault();
            selectTermBox(box);
        }
        try {
            document.execCommand('copy');
            toast('已复制框内内容');
        } catch (err) {
            toast('复制失败', 'error');
        }
    }
});

// ==============================

function toggleTimelineDetail(header) {
    const detail = header.nextElementSibling;
    if (detail && detail.classList.contains('timeline-detail')) {
        const toggle = header.querySelector('.timeline-toggle');
        if (detail.style.display === 'none') {
            detail.style.display = '';
            toggle.className = 'fas fa-chevron-down timeline-toggle';
        } else {
            detail.style.display = 'none';
            toggle.className = 'fas fa-chevron-right timeline-toggle';
        }
    }
}

function toggleTaskDetail(section) {
    const detail = section.nextElementSibling;
    if (detail && detail.classList.contains('task-detail-json')) {
        const toggle = section.querySelector('.task-detail-toggle');
        if (detail.style.display === 'none') {
            detail.style.display = '';
            if (toggle) toggle.className = 'fas fa-chevron-down task-detail-toggle';
        } else {
            detail.style.display = 'none';
            if (toggle) toggle.className = 'fas fa-chevron-right task-detail-toggle';
        }
    }
}

const DEFAULT_BODY = `{
  "linkid": "sim-xxx",
  "callback_url": "",
  "files": [
    {"file_url": "http://example.com/doc.pdf", "file_name": "doc.pdf"}
  ],
  "form_data": {
    "doc_type": "company",
    "source_type": "group"
  }
}`;

async function loadSimulateTab() {
    const res = await fetch(API + '/interfaces');
    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : [];
    const sel = document.getElementById('simIface');
    sel.innerHTML = '<option value="">-- 请选择访问路径 --</option>' +
        list.map(i => '<option value="' + escHtml(i.path) + '">' + escHtml(i.name) + ' (' + escHtml(i.path) + ')</option>').join('');

    if (!document.getElementById('simBody').value.trim()) {
        try {
            const mr = await fetch(API + '/mock');
            const mj = await mr.json();
            if (mj.code === 0 && mj.data) {
                document.getElementById('simBody').value = JSON.stringify(mj.data, null, 2);
                return;
            }
        } catch { /* ignore */ }
        document.getElementById('simBody').value = DEFAULT_BODY;
    }
}

document.getElementById('simSubmit').addEventListener('click', async () => {
    const ifacePath = document.getElementById('simIface').value;
    const bodyStr = document.getElementById('simBody').value.trim();

    if (!ifacePath) return toast('请选择访问路径', 'error');
    if (!bodyStr) return toast('请输入请求体 JSON', 'error');

    let requestBody;
    try {
        requestBody = JSON.parse(bodyStr);
    } catch (e) {
        return toast('请求体 JSON 格式错误: ' + e.message, 'error');
    }

    const btn = document.getElementById('simSubmit');
    const wrap = document.getElementById('simResultWrap');
    const resultPre = document.getElementById('simResult');
    const curlPre = document.getElementById('simCurl');
    const curlToggle = document.getElementById('simCurlToggle');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 提交中...';
    wrap.style.display = 'none';

    // 从后端获取真实的服务器地址（协议/IP/端口）
    let proto = window.location.protocol;
    let host = window.location.hostname;
    let port = window.location.port || (proto === 'https:' ? '443' : '80');
    try {
        const siRes = await fetch(API + '/server-info');
        const siJson = await siRes.json();
        if (siJson.data) {
            proto = siJson.data.protocol + ':';
            host = siJson.data.host;
            port = String(siJson.data.port);
        }
    } catch { /* fallback to window.location */ }

    // 生成等效 curl 命令
    const apiPath = '/api/v1/' + ifacePath;
    const needPort = (proto === 'https:' && port !== '443') || (proto === 'http:' && port !== '80');
    const apiUrl = proto + '//' + host + (needPort ? ':' + port : '') + apiPath;
    const bodyJson = JSON.stringify(requestBody);
    const curlCmd = `curl -k --noproxy '*' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer sk-***' \\
  -d '${bodyJson.replace(/'/g, "'\\''")}' \\
  ${apiUrl}`;

    curlPre.textContent = curlCmd;
    curlPre.style.display = 'none';
    curlToggle.className = 'fas fa-chevron-right';

    try {
        const res = await fetch(API + '/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interface_path: ifacePath, request_body: requestBody })
        });
        const json = await res.json();
        resultPre.textContent = JSON.stringify(json, null, 2);
    } catch (e) {
        resultPre.textContent = '网络错误: ' + e.message;
    }
    wrap.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-play"></i> 提交';
});

function toggleSimCurl() {
    const curl = document.getElementById('simCurl');
    const toggle = document.getElementById('simCurlToggle');
    if (curl.style.display === 'none') {
        curl.style.display = '';
        toggle.className = 'fas fa-chevron-down';
    } else {
        curl.style.display = 'none';
        toggle.className = 'fas fa-chevron-right';
    }
}

function toggleConfigKeys() {
    const table = document.getElementById('configKeysTable');
    const toggle = document.getElementById('configKeysToggle');
    if (table.style.display === 'none') {
        table.style.display = '';
        toggle.className = 'fas fa-chevron-down';
    } else {
        table.style.display = 'none';
        toggle.className = 'fas fa-chevron-right';
    }
}

function togglePreview() {
    const files = document.getElementById('previewFiles');
    const toggle = document.getElementById('previewToggle');
    if (files.style.display === 'none') {
        files.style.display = '';
        toggle.className = 'fas fa-chevron-down';
    } else {
        files.style.display = 'none';
        toggle.className = 'fas fa-chevron-right';
    }
}

async function doLogout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (_) {
        // 忽略网络错误；若 token 已过期则 401 拦截器已触发跳转
    }
    if (!_loginRedirecting) {
        window.location.href = '/login';
    }
}

// ==== 系统设置 ====
async function loadSysConfig() {
    try {
        const res = await fetch(API + '/sys-config');
        const json = await res.json();
        if (json.data) {
            const sysName = json.data.sys.name || 'AI 数字员工';
            document.getElementById('sysName').value = sysName;
            // 同步更新页面标题和 header
            const title = sysName;
            document.getElementById('pageTitle').textContent = title;
            document.getElementById('sysNameHeader').textContent = title;
            const apiEnabled = json.data.api && json.data.api.auth_enabled;
            document.getElementById('apiAuthEnabled').checked = apiEnabled || false;
            document.getElementById('apiAuthToken').value = (json.data.api && json.data.api.auth_token) || '';
            document.getElementById('apiTokenRow').style.display = apiEnabled ? 'flex' : '';
        }
    } catch (_) {}
}

function generateAPIToken() {
    const chars = '0123456789abcdef';
    let token = '';
    for (let i = 0; i < 32; i++) token += chars[Math.floor(Math.random() * 16)];
    document.getElementById('apiAuthToken').value = token;
}

function toggleTokenVisibility() {
    const inp = document.getElementById('apiAuthToken');
    const icon = document.querySelector('#apiTokenRow .fa-eye, #apiTokenRow .fa-eye-slash');
    if (inp.type === 'password') {
        inp.type = 'text';
        if (icon) icon.className = 'fas fa-eye-slash';
    } else {
        inp.type = 'password';
        if (icon) icon.className = 'fas fa-eye';
    }
}

async function saveSysConfig() {
    try {
        const res = await fetch(API + '/sys-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sys: { name: document.getElementById('sysName').value },
                api: {
                    auth_enabled: document.getElementById('apiAuthEnabled').checked,
                    auth_token: document.getElementById('apiAuthToken').value
                }
            })
        });
        const json = await res.json();
        if (json.code === 0) toast('保存成功', 'success');
        else toast(json.message || '保存失败', 'error');
    } catch (err) { toast('保存失败: ' + err.message, 'error'); }
}

// ==== 用户管理 ====
async function loadUsers() {
    try {
        const res = await fetch(API + '/users');
        const json = await res.json();
        const data = json.data || [];
        const tbody = document.getElementById('usersTbody');
        tbody.innerHTML = data.map(function(u, idx) {
            const roleLabel = u.role === 1 ? '管理员' : '普通用户';
            return '<tr><td>' + (idx + 1) + '</td><td>' + escHtml(u.user_name) + '</td><td>' + roleLabel + '</td><td>' + escHtml(u.note||'') + '</td>' +
                '<td>' + (u.user_name !== 'admin' ? '<button class="cfg-btn cfg-btn-reset" onclick="deleteUser(\'' + escHtml(u.user_name) + '\')" style="padding:4px 10px;font-size:0.8rem;color:#c62828;">删除</button>' : '') + '</td></tr>';
        }).join('');
    } catch (err) { toast('加载用户失败: ' + err.message, 'error'); }
}

async function addUser() {
    const name = document.getElementById('newUserName').value.trim();
    const pwd = document.getElementById('newUserPwd').value.trim();
    const role = parseInt(document.getElementById('newUserRole').value);
    if (!name || !pwd) { toast('用户名和密码不能为空', 'error'); return; }
    try {
        const res = await fetch(API + '/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_name: name, user_pwd: pwd, role: role })
        });
        const json = await res.json();
        if (json.code === 0) {
            toast('添加成功', 'success');
            loadUsers();
            document.getElementById('newUserName').value = '';
            document.getElementById('newUserPwd').value = '';
        } else {
            toast(json.message || '添加失败', 'error');
        }
    } catch (err) { toast('添加失败: ' + err.message, 'error'); }
}

async function deleteUser(username) {
    if (!confirm('确定删除用户 ' + username + '？')) return;
    try {
        const res = await fetch(API + '/users/' + encodeURIComponent(username), { method: 'DELETE' });
        const json = await res.json();
        if (json.code === 0) { toast('删除成功', 'success'); loadUsers(); }
        else { toast(json.message || '删除失败', 'error'); }
    } catch (err) { toast('删除失败: ' + err.message, 'error'); }
}

// ==== 任务审查 ====
function closeAuditDetail() {
    _auditDetailData = null;
    document.getElementById('auditDetailModal').classList.remove('show');
}

const AUDIT_PAGE_SIZE = 10;
let _auditPage = 1;
let _auditTotal = 0;
let _auditMode = 0;  // 0=最近, 1=搜索

async function loadAudit(mode, page = 1) {
    _auditMode = mode;
    let url = API + '/audit?page=' + page + '&page_size=' + AUDIT_PAGE_SIZE;
    if (mode === 1) {
        const taskId = document.getElementById('auditTaskId').value.trim();
        const linkId = document.getElementById('auditLinkId').value.trim();
        if (!taskId && !linkId) { toast('请输入 Task ID 或 Link ID', 'error'); return; }
        const params = new URLSearchParams();
        if (taskId) params.set('task_id', taskId);
        if (linkId) params.set('linkid', linkId);
        params.set('page', page);
        params.set('page_size', AUDIT_PAGE_SIZE);
        url = API + '/audit?' + params.toString();
    }

    try {
        _auditPage = page;
        const res = await fetch(url);
        const json = await res.json();
        const data = json.data || {};
        const list = Array.isArray(data.items) ? data.items : [];
        _auditTotal = data.total || 0;
        renderAuditPage(list);
    } catch (err) { toast('查询失败: ' + err.message, 'error'); }
}

function renderAuditPage(list) {
    const total = _auditTotal;
    const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
    const tbody = document.getElementById('auditTbody');
    if (total === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#999;padding:24px;">暂无记录</td></tr>';
        document.getElementById('auditPager').innerHTML = '';
        return;
    }
    const start = (_auditPage - 1) * AUDIT_PAGE_SIZE;
    tbody.innerHTML = list.map((t, i) => {
        const no = start + i + 1;
        const rid = 'arow-' + no;
        const taskId = escHtml(t.task_id);
        const title = t.title || '-';
        const titleDisplay = title.length > 20 ? escHtml(title.substring(0, 20)) + '...' : escHtml(title);
        return `<tr class="main-row">
            <td class="col-seq">${no}</td>
            <td class="col-title"><span title="${escHtml(title)}" onclick="toggleRowDetail('${rid}')" style="cursor:pointer;color:#4b6cb7;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:4px;">${titleDisplay}</span></td>
            <td>${escHtml(t.path || '-')}</td>
            <td><code style="font-size:0.78rem;">${escHtml((t.linkid || '-').substring(0,8))}...</code></td>
            <td>${statusText(t.status)}</td>
            <td class="col-date">${fmtTs(t.created_at)}</td>
            <td class="col-action"><button class="cfg-btn-sm cfg-btn-icon cfg-btn-icon-primary" onclick="viewAuditDetail('${taskId}')" title="时间线"><i class="fas fa-history"></i></button></td>
        </tr>
        <tr class="row-detail" id="${rid}" style="display:none;">
            <td colspan="9" style="padding:4px 12px 8px;font-size:0.82rem;color:#555;user-select:text;">
                <span class="audit-info-label">Task ID:</span> <code style="font-size:0.82rem;">${taskId}</code>
                &nbsp;&nbsp;&nbsp;
                <span class="audit-info-label">Link ID:</span> <code style="font-size:0.82rem;">${escHtml(t.linkid || '-')}</code>
            </td>
        </tr>`;
    }).join('');
    document.getElementById('auditPager').innerHTML = pagerHtml(_auditPage, totalPages, 'loadAudit', _auditMode);
}

function closeStreamModal() {
    if (_streamEs) { _streamEs.close(); _streamEs = null; }
    _streamSessionId = null;
    _streamCount = 0;
    document.getElementById('streamModal').classList.remove('show');
}

// ==============================
// 会话管理
// ==============================
async function loadSessions() {
    const tbody = document.getElementById('sessionsTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:24px;">加载中...</td></tr>';
    let list = [];
    try {
        const r = await fetch('/admin/sessions');
        const j = await r.json();
        list = j.data || [];
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#e53e3e;padding:24px;">加载失败</td></tr>';
        return;
    }
    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:24px;">暂无会话</td></tr>';
        return;
    }
    tbody.innerHTML = list.map((s, i) => {
        const sid = s.session_id || '';
        const short = sid.length > 12 ? sid.substring(0, 12) : sid;
        return `<tr>
            <td class="col-seq">${i + 1}</td>
            <td><span title="${escHtml(sid)}" style="font-family:monospace;font-size:0.82rem;">${escHtml(short)}</span></td>
            <td>${escHtml(s.linkid || '-')}</td>
            <td>${s.status === 'active' ? '<span class="badge badge-processing">活跃</span>' : '<span class="badge badge-cancelled">关闭</span>'}</td>
            <td class="col-date">${fmtTs(s.created_at)}</td>
            <td class="col-date">${fmtTs(s.updated_at)}</td>
            <td class="col-action" style="width:80px;">
                <button class="cfg-btn-sm cfg-btn-icon cfg-btn-icon-primary" onclick="openChat('${escHtml(sid)}', '${escHtml(s.linkid || '')}')" title="进入会话续聊" style="margin-right:4px;"><i class="fas fa-comment-dots"></i></button>
                <button class="cfg-btn-danger-sm" onclick="deleteSession('${escHtml(sid)}', '${escHtml(s.linkid || '')}')" title="删除会话"><i class="fas fa-trash-alt"></i></button>
            </td>
        </tr>`;
    }).join('');
}

async function deleteSession(sessionId, linkid) {
    if (!confirm('删除会话 ' + sessionId.substring(0, 12) + '... ?\n\n将同时清理该公文 (' + (linkid || '-') + ') 的 SDK 工作目录，包含上下文快照。')) return;
    try {
        const r = await fetch('/admin/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' });
        const j = await r.json();
        if (j.code === 0) {
            toast('已删除', 'success');
            loadSessions();
        } else {
            toast(j.message || '删除失败', 'error');
        }
    } catch (e) {
        toast('删除失败: ' + e.message, 'error');
    }
}

// ---- 会话续聊（debug 用，终端风格）----
let _chatEs = null;
let _chatSessionId = '';
let _chatCount = 0;      // 已渲染历史消息数

// 终端追加（统一走 innerHTML + escHtml，颜色用 span）
function chatAppend(html) {
    const term = document.getElementById('chatTerminal');
    term.innerHTML += html;
    term.scrollTop = term.scrollHeight;
}

function chatSet(html) {
    const term = document.getElementById('chatTerminal');
    term.innerHTML = html;
    term.scrollTop = term.scrollHeight;
}

async function openChat(sessionId, linkid) {
    console.log('[openChat] sessionId:', sessionId, 'linkid:', linkid);
    _chatSessionId = sessionId;
    _chatCount = 0;
    document.getElementById('chatModalTitle').innerHTML = '<i class="fas fa-terminal"></i> 会话终端';
    document.getElementById('chatStatus').textContent = linkid || '-';
    document.getElementById('chatInput').value = '';
    document.getElementById('chatModal').classList.add('show');
    document.getElementById('chatInput').focus();

    chatSet('<span style="color:#6a9955;"># 加载历史消息...</span>');

    try {
        const url = API + '/sessions/' + encodeURIComponent(sessionId) + '/messages';
        console.log('[openChat] fetch:', url);
        const res = await fetch(url);
        const json = await res.json();
        console.log('[openChat] response code:', json.code, 'messages:', Array.isArray(json.data?.messages) ? json.data.messages.length : 'N/A');
        const data = json.data || {};
        const messages = Array.isArray(data.messages) ? data.messages : [];
        _chatCount = messages.length;
        const { output } = formatSessionMessages(messages, 0);
        chatSet('<span style="color:#6a9955;"># 共 ' + messages.length + ' 条消息</span>\n\n' + escHtml(output || '(空会话)'));
    } catch (e) {
        console.error('[openChat] error:', e);
        chatSet('<span style="color:#f44747;"># 加载失败: ' + escHtml(e.message) + '</span>');
    }
}

async function newChat() {
    const msg = prompt('请输入第一条消息：', '你好，请帮我分析公司现有业务知识。');
    if (!msg || !msg.trim()) return;

    _chatSessionId = '';
    _chatCount = 0;
    document.getElementById('chatModalTitle').innerHTML = '<i class="fas fa-terminal"></i> 新建聊天';
    document.getElementById('chatStatus').innerHTML = '<span style="color:#4ec9b0;">● 创建中...</span>';
    document.getElementById('chatInput').value = '';
    document.getElementById('chatModal').classList.add('show');
    document.getElementById('chatInput').focus();

    chatSet('<span style="color:#6a9955;"># 创建聊天上下文，首次发送：</span>\n' + escHtml(msg) + '\n');

    const status = document.getElementById('chatStatus');
    status.innerHTML = '<span style="color:#4ec9b0;">● thinking...</span>';

    try {
        const r = await fetch(API + '/chat/new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg }),
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j.message || r.statusText);
        }

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const m = JSON.parse(line.slice(6));
                    // capture session_id for subsequent messages
                    const sid = m.session_id || (m.type === 'end' ? m.session_id : '');
                    if (sid && !_chatSessionId) {
                        _chatSessionId = sid;
                        document.getElementById('chatModalTitle').innerHTML = '<i class="fas fa-terminal"></i> 聊天 ' + escHtml(sid.substring(0,8));
                    }
                    if (m.type === 'end') {
                        if (m.session_id) _chatSessionId = m.session_id;
                        continue;
                    }
                    if (m.type === 'error') {
                        chatAppend('\n<span style="color:#f44747;">[错误]</span> ' + escHtml(m.message || '') + '\n');
                        continue;
                    }
                    if (m.type === 'user' || m.type === 'assistant') {
                        const { output } = formatSessionMessages([m], _chatCount);
                        chatAppend(escHtml(output));
                        _chatCount++;
                    }
                } catch { /* skip malformed */ }
            }
        }
        status.innerHTML = '<span style="color:#6a9955;">✓ done</span>';
    } catch (e) {
        chatAppend('\n<span style="color:#f44747;">[错误]</span> ' + escHtml(e.message) + '\n');
        status.innerHTML = '<span style="color:#f44747;">✗ ' + escHtml(e.message) + '</span>';
    }
    document.getElementById('chatInput').disabled = false;
    document.getElementById('chatInput').focus();
}

function closeChatModal() {
    if (_chatEs) { _chatEs.close(); _chatEs = null; }
    _chatSessionId = '';
    _chatCount = 0;
    document.getElementById('chatModal').classList.remove('show');
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const msg = input.value.trim();
    if (!msg || !_chatSessionId) return;
    input.value = '';
    input.disabled = true;

    const status = document.getElementById('chatStatus');

    // 终端追加用户消息（复用 fmtTimelineTs 保持与历史消息时间格式一致）
    const ts = fmtTimelineTs(new Date().toISOString());
    chatAppend('\n[' + ts + '] <span style="color:#4ec9b0;">[你]</span>\n' + escHtml(msg) + '\n');
    status.innerHTML = '<span style="color:#4ec9b0;">● thinking...</span>';

    try {
        const r = await fetch('/admin/sessions/' + encodeURIComponent(_chatSessionId) + '/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg }),
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j.message || r.statusText);
        }

        // 收 SSE 流，复用 formatSessionMessages 保持渲染一致
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const m = JSON.parse(line.slice(6));
                    if (m.type === 'end') continue;
                    if (m.type === 'error') {
                        chatAppend('\n<span style="color:#f44747;">[错误]</span> ' + escHtml(m.message || '') + '\n');
                        continue;
                    }
                    if (m.type === 'user' || m.type === 'assistant') {
                        const { output } = formatSessionMessages([m], _chatCount);
                        chatAppend(escHtml(output));
                        _chatCount++;
                    }
                } catch { /* skip malformed */ }
            }
        }
        status.innerHTML = '<span style="color:#6a9955;">✓ done</span>';
    } catch (e) {
        chatAppend('\n<span style="color:#f44747;">[错误]</span> ' + escHtml(e.message) + '\n');
        status.innerHTML = '<span style="color:#f44747;">✗ ' + escHtml(e.message) + '</span>';
    } finally {
        input.disabled = false;
        input.focus();
    }
}

// ---- 会话记录实时推送（SSE）----
let _streamEs = null;         // EventSource 实例
let _streamSessionId = null;
let _streamCount = 0;         // 已渲染消息条数
let _streamMessages = [];     // 原始消息数组，供导出使用

function formatSessionMessages(messages, startSeq) {
    let output = '';
    let seq = startSeq;
    for (const msg of messages) {
        seq++;
        const ts = msg.message?.timestamp || msg.timestamp || '';
        const tsStr = ts ? fmtTimelineTs(ts) : '';
        if (msg.type === 'user') {
            output += '\n' + '='.repeat(60) + '\n[' + seq + '] ' + tsStr + ' [用户]\n';
            const c = msg.message?.content;
            if (typeof c === 'string') {
                output += c + '\n';
            } else if (Array.isArray(c)) {
                for (const b of c) {
                    if (b.type === 'text' && b.text) {
                        output += b.text + '\n';
                    } else if (b.type === 'tool_result') {
                        output += '┌─ [工具返回]';
                        if (b.tool_use_id) output += '  (' + b.tool_use_id + ')';
                        output += '\n';
                        if (b.content) {
                            if (typeof b.content === 'string') {
                                output += '│ ' + b.content.replace(/\n/g, '\n│ ') + '\n';
                            } else if (Array.isArray(b.content)) {
                                for (const cb of b.content) {
                                    if (cb.type === 'text' && cb.text) output += '│ ' + cb.text.replace(/\n/g, '\n│ ') + '\n';
                                }
                            }
                        }
                        output += '└─\n';
                    }
                }
            }
        } else if (msg.type === 'assistant') {
            output += '\n' + '-'.repeat(60) + '\n[' + seq + '] ' + tsStr + ' [助手]\n';
            const c = msg.message?.content;
            if (typeof c === 'string') {
                output += c + '\n';
            } else if (Array.isArray(c)) {
                for (const b of c) {
                    if (b.type === 'text' && b.text) {
                        output += b.text + '\n';
                    } else if (b.type === 'tool_use') {
                        output += '┌─ >> 工具调用: ' + (b.name || '?');
                        if (b.id) output += '  (' + b.id + ')';
                        output += '\n';
                        if (b.input) {
                            output += '│ ' + JSON.stringify(b.input, null, 2).replace(/\n/g, '\n│ ') + '\n';
                        }
                        output += '└─\n';
                    } else if (b.type === 'thinking' && b.thinking) {
                        output += '┌─ 🤔 思考:\n';
                        output += '│ ' + b.thinking.replace(/\n/g, '\n│ ') + '\n';
                        output += '└─\n';
                    } else if (b.type === 'redacted_thinking') {
                        output += '┌─ 🤔 思考 (已过滤): 内容不可见\n└─\n';
                    }
                }
            }
        }
    }
    return { output, endSeq: seq };
}

function mdCodeBlock(text, lang) {
    // 动态围栏：外层反引号数比内容里最长的连续反引号串多 1，避免内容中的 ``` 提前闭合
    let maxRun = 0, run = 0;
    for (const ch of text) {
        if (ch === '`') { run++; if (run > maxRun) maxRun = run; }
        else run = 0;
    }
    const fence = '`'.repeat(Math.max(3, maxRun + 1));
    return fence + (lang || '') + '\n' + text + '\n' + fence + '\n\n';
}

function formatSessionMessagesMD(messages, sessionId) {
    let md = '# 会话记录 ' + sessionId + '\n\n';
    let seq = 0;
    for (const msg of messages) {
        seq++;
        const ts = msg.message?.timestamp || msg.timestamp || '';
        const tsStr = ts ? fmtTimelineTs(ts) : '';
        const roleLabel = msg.type === 'user' ? '用户' : msg.type === 'assistant' ? '助手' : msg.type;
        md += '## [' + seq + '] ' + tsStr + ' [' + roleLabel + ']\n\n';
        const c = msg.message?.content;
        if (typeof c === 'string') {
            md += mdCodeBlock(c);
        } else if (Array.isArray(c)) {
            for (const b of c) {
                if (b.type === 'text' && b.text) {
                    md += mdCodeBlock(b.text);
                } else if (b.type === 'tool_use') {
                    md += '> >> 工具调用: ' + (b.name || '?');
                    if (b.id) md += '  (' + b.id + ')';
                    md += '\n>\n';
                    if (b.input) {
                        md += mdCodeBlock(JSON.stringify(b.input, null, 2), 'json');
                    }
                } else if (b.type === 'tool_result') {
                    md += '> [工具返回]';
                    if (b.tool_use_id) md += '  (' + b.tool_use_id + ')';
                    md += '\n>\n';
                    let toolText = '';
                    if (typeof b.content === 'string') {
                        toolText = b.content;
                    } else if (Array.isArray(b.content)) {
                        for (const cb of b.content) {
                            if (cb.type === 'text' && cb.text) toolText += cb.text;
                        }
                    }
                    if (toolText) {
                        md += mdCodeBlock(toolText);
                    } else {
                        md += '\n';
                    }
                } else if (b.type === 'thinking' && b.thinking) {
                    md += '> 🤔 思考:\n>\n';
                    md += mdCodeBlock(b.thinking);
                } else if (b.type === 'redacted_thinking') {
                    md += '> 🤔 思考 (已过滤): 内容不可见\n\n';
                }
            }
        }
    }
    return md;
}

function exportStreamMD() {
    if (!_streamMessages || _streamMessages.length === 0) {
        return toast('没有可导出的消息', 'error');
    }
    const sessionId = _streamSessionId || 'session';
    // 文件名只用前 8 位，避免过长
    const shortId = sessionId.length > 8 ? sessionId.substring(0, 8) : sessionId;
    const hostname = window.location.hostname || 'localhost';
    const filename = 'session_' + shortId + '_' + hostname + '.md';
    const md = formatSessionMessagesMD(_streamMessages, sessionId);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('已导出: ' + filename, 'success');
}

async function viewSession(sessionId, taskId, taskStatus) {
    if (!sessionId) return toast('该任务无关联 Session', 'error');

    // 关闭上一次的 SSE 连接
    if (_streamEs) { _streamEs.close(); _streamEs = null; }
    _streamSessionId = sessionId;
    _streamCount = 0;

    document.getElementById('streamModalTitle').innerHTML = '<i class="fas fa-comments"></i> 会话记录 <span style="font-weight:400;font-size:0.8rem;color:#888;">' + escHtml(sessionId) + '</span>';
    document.getElementById('streamStatus').innerHTML = '<span style="color:#4b6cb7;">加载中...</span>';
    /* merged into title */

    const container = document.getElementById('streamMessages');
    container.textContent = '加载中...';
    document.getElementById('streamModal').classList.add('show');

    const active = ['pending', 'processing'].includes(taskStatus);

    if (!active) {
        // 任务已结束：一次性拉取完整历史
        try {
            const url = API + '/sessions/' + encodeURIComponent(sessionId) + '/messages';
            console.log('[viewSession] finished task, fetch:', url);
            const res = await fetch(url);
            const json = await res.json();
            console.log('[viewSession] response code:', json.code, 'messages:', Array.isArray(json.data?.messages) ? json.data.messages.length : 'N/A');
            const data = json.data || {};
            const messages = Array.isArray(data.messages) ? data.messages : [];
            _streamMessages = messages;
            const { output } = formatSessionMessages(messages, 0);
            container.textContent = output || '(空会话)';
            _streamCount = messages.length;
            document.getElementById('streamStatus').innerHTML = '<span style="color:#4b6cb7;">共 ' + messages.length + ' 条消息</span>';
            /* merged into title */
        } catch (err) {
            console.error('[viewSession] error:', err);
            container.textContent = '读取会话记录失败: ' + err.message;
        }
        return;
    }

    // 任务处理中：订阅 SSE，实时接收快照 + 增量消息
    const es = new EventSource(API + '/sessions/' + encodeURIComponent(sessionId) + '/stream');
    _streamEs = es;

    es.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        // 快照：全量历史
        if (msg.type === 'snapshot') {
            const messages = Array.isArray(msg.messages) ? msg.messages : [];
            _streamMessages = messages;
            const { output } = formatSessionMessages(messages, 0);
            container.textContent = output || '(空会话)';
            _streamCount = messages.length;
            document.getElementById('streamStatus').innerHTML = '<span style="color:#4b6cb7;">共 ' + messages.length + ' 条消息</span>';
            /* merged into title */
            container.scrollTop = container.scrollHeight;
        } else if (msg.type === 'error') {
            container.textContent = '读取会话记录失败: ' + (msg.message || '');
        } else if (msg.type === 'end') {
            // 任务结束，直接用局部引用关闭连接（防止 onerror 竞态导致 _streamEs 已被置 null）
            es.close();
            _streamEs = null;
            /* merged into title */
        } else {
            // 增量消息：全部存储供导出，仅 user/assistant 更新显示和计数
            _streamMessages.push(msg);
            if (msg.type === 'user' || msg.type === 'assistant') {
                const { output } = formatSessionMessages([msg], _streamCount);
                container.textContent += output;
                _streamCount++;
                document.getElementById('streamStatus').innerHTML = '<span style="color:#4b6cb7;">共 ' + _streamCount + ' 条消息</span>';
            }
            container.scrollTop = container.scrollHeight;
        }
    };

    es.onerror = () => {
        // SSE 连接错误（如任务已结束导致服务端关闭连接），保持已显示内容
        if (_streamEs === es) {
            _streamEs = null;
        }
    };
}

function toggleRowDetail(rid) {
    var el = document.getElementById(rid);
    if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

function pagerHtml(page, totalPages, fnName, mode) {
    const modeArg = (mode === undefined) ? '' : (mode + ',');
    return '<span style="color:#888;font-size:0.85rem;">第 ' + page + ' / ' + totalPages + ' 页</span>' +
        '<button class="cfg-btn-sm" onclick="' + fnName + '(' + modeArg + (page - 1) + ')"' + (page <= 1 ? ' disabled' : '') + '><i class="fas fa-chevron-left"></i> 上一页</button>' +
        '<button class="cfg-btn-sm" onclick="' + fnName + '(' + modeArg + (page + 1) + ')"' + (page >= totalPages ? ' disabled' : '') + '>下一页 <i class="fas fa-chevron-right"></i></button>';
}

let _auditDetailData = null;  // 当前查看的详情数据，供导出使用

async function viewAuditDetail(taskId) {
    try {
        const res = await fetch(API + '/audit/' + encodeURIComponent(taskId));
        const json = await res.json();
        const t = json.data;
        if (!t) return toast('未找到', 'error');
        _auditDetailData = t;
        document.getElementById('auditDetailContent').innerHTML = auditTimelineHtml(t);
        document.getElementById('auditDetailModal').classList.add('show');
    } catch (err) { toast('加载详情失败: ' + err.message, 'error'); }
}

function auditTimelineHtml(t) {
    const events = buildAuditEvents(t);
    const title = t.title || '-';
    const startStr = fmtTs(t.created_at);
    const endStr = t.finished_at ? fmtTs(t.finished_at) : '处理中';
    // 顶部信息条（固定不随滚动）
    let html = '<div class="audit-info-bar" style="flex-shrink:0;">' +
        '<div class="audit-info-row"><span class="audit-info-label">标题:</span> <span class="audit-info-title">' + escHtml(title) + '</span></div>' +
        '<div class="audit-info-row"><span class="audit-info-label">执行周期:</span> ' + escHtml(startStr) + ' ~ ' + escHtml(endStr) + '</div>' +
        '<div class="audit-info-row"><span class="audit-info-label">Task ID:</span> ' + escHtml(t.task_id) + ' <span class="audit-info-label" style="margin-left:16px;">Link ID:</span> ' + escHtml(t.linkid || '-') + '</div>' +
        '</div>';
    // 时间线 — 可滚动
    html += '<div class="audit-timeline-scroll" style="flex:1;min-height:0;">';
    html += '<div class="audit-timeline">';
    let step = 0;
    for (const ev of events) {
        step++;
        const icon = ev.type === 'tool' ? 'fa-wrench'
            : ev.type === 'input' ? 'fa-inbox'
            : ev.type === 'output' ? 'fa-arrow-right'
            : ev.type === 'done' ? 'fa-check-circle'
            : ev.type === 'error' ? 'fa-times-circle'
            : ev.type === 'create' ? 'fa-plus-circle'
            : ev.type === 'prompt' ? 'fa-file-code'
            : 'fa-circle';
        const cls = ev.type === 'error' ? 'error'
            : ev.type === 'done' ? 'done'
            : 'info';
        html += '<div class="timeline-item ' + cls + '">';
        html += '<div class="timeline-dot"><i class="fas ' + icon + '"></i></div>';
        html += '<div class="timeline-body">';
        html += '<div class="timeline-header" onclick="toggleTimelineDetail(this)" style="cursor:pointer;">';
        if (ev.time) html += '<span class="timeline-time">' + fmtTimelineTs(ev.time) + '</span>';
        html += '<strong>' + step + '. ' + escHtml(ev.title) + '</strong>';
        html += '<i class="fas fa-chevron-right timeline-toggle" style="margin-left:auto;color:#999;font-size:0.75rem;"></i></div>';
        if (ev.detail) {
            html += '<pre class="timeline-detail term-box" style="display:none;">' + escHtml(ev.detail) + '</pre>';
        }
        html += '</div></div>';
    }
    html += '</div>';
    html += '</div>';  // close audit-timeline-scroll
    return html;
}

function buildAuditEvents(t) {
    const events = [];
    // 1. 任务创建
    events.push({ time: t.created_at, type: 'create', title: '任务创建', detail: '访问路径: ' + (t.path || '-') });
    // 2. 收到请求数据
    if (t.request_body) {
        events.push({ time: t.created_at, type: 'input', title: '收到请求数据', detail: jsonFmt(t.request_body) });
    }
    // 3. 返回同步响应
    if (t.request_response) {
        events.push({ time: t.created_at, type: 'output', title: '返回同步响应', detail: jsonFmt(t.request_response) });
    }
    // 4. 渲染提示词
    if (t.prompt) {
        events.push({ time: t.created_at, type: 'prompt', title: '渲染提示词', detail: t.prompt });
    }
    // 5. Agent 输出结果（查看上方「对话」按钮可获取完整 SDK 对话记录）
    // 6. Agent 最终输出
    if (t.sdk_output) {
        events.push({ time: t.finished_at, type: 'output', title: 'Agent 输出结果', detail: t.sdk_output });
    }
    // 7. 结果回调（从 SDK trace 中提取 Bash curl 记录）
    const cbEvent = tryExtractCallbackFromTrace(t.sdk_trace, t.finished_at);
    if (cbEvent) events.push(cbEvent);
    // 8. 完成 / 失败
    events.push({
        time: t.finished_at,
        type: t.status === 'completed' ? 'done' : (t.status === 'failed' ? 'error' : 'info'),
        title: statusText(t.status),
        detail: t.error_message || ''
    });
    return events;
}

function tryExtractCallbackFromTrace(sdkTrace, fallbackTime) {
    if (!sdkTrace) return null;
    let messages;
    try { messages = JSON.parse(sdkTrace); } catch { return null; }
    if (!Array.isArray(messages) || messages.length === 0) return null;

    const callbackIds = new Set();
    for (const msg of messages) {
        if (msg.type !== 'assistant') continue;
        for (const block of (msg.message?.content || [])) {
            if (block.type !== 'tool_use' || block.name !== 'Bash') continue;
            const cmd = typeof block.input?.command === 'string' ? block.input.command : '';
            if (cmd.includes('/tmp/callback_payload') || cmd.includes('callback')) {
                if (block.id) callbackIds.add(block.id);
            }
        }
    }
    if (callbackIds.size === 0) return null;

    const results = [];
    for (const msg of messages) {
        if (msg.type !== 'user') continue;
        for (const block of (msg.message?.content || [])) {
            if (block.type !== 'tool_result') continue;
            if (block.tool_use_id && !callbackIds.has(block.tool_use_id)) continue;
            const raw = block.content;
            if (typeof raw === 'string') {
                results.push({ toolId: block.tool_use_id || '', content: raw });
            } else if (Array.isArray(raw)) {
                results.push({ toolId: block.tool_use_id || '', content: raw.map(c => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('') });
            }
        }
    }
    if (results.length === 0) return null;

    const allOk = results.every(r => !r.content.includes('curl: (') && !r.content.includes('command failed') && !r.content.includes('Error'));
    let detail = results.map(r => r.content.trim()).join('\n\n---\n\n');
    if (results.length > 1) detail = results.map((r, i) => '[' + (i + 1) + ']\n' + r.content.trim()).join('\n\n');

    return {
        time: fallbackTime,
        type: allOk ? 'done' : 'error',
        title: allOk ? '回调成功' : '回调失败',
        detail: detail
    };
}

function exportAuditMd() {
    const t = _auditDetailData;
    if (!t) return toast('无数据', 'error');
    const linkid = t.linkid || t.task_id?.substring(0, 8) || 'export';

    // 直接请求后端渲染的 HTML 页面，保持与 API 一致
    fetch('/api/v1/task/log/' + encodeURIComponent(t.task_id) + '?format=html')
        .then(r => r.text())
        .then(html => {
            const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = linkid + '.html';
            a.click();
            URL.revokeObjectURL(a.href);
            toast('已导出');
        })
        .catch(err => toast('导出失败: ' + err.message));
}