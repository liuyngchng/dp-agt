// ============================================================
// AI 数字员工 - 登录页
// ============================================================

// 切换密码明文/密文显示
function togglePwd(icon) {
    const input = icon.parentElement.querySelector('input');
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fas fa-eye-slash pwd-eye';
    } else {
        input.type = 'password';
        icon.className = 'fas fa-eye pwd-eye';
    }
}

document.getElementById('loginForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const userName = document.getElementById('userName').value.trim();
    const userPwd = document.getElementById('userPwd').value.trim();
    const errorDiv = document.getElementById('loginError');
    const errorMsg = document.getElementById('loginErrorMsg');

    if (!userName || !userPwd) {
        errorMsg.textContent = '用户名和密码不能为空';
        errorDiv.style.display = 'flex';
        return;
    }

    try {
        const resp = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_name: userName, user_pwd: userPwd })
        });
        const data = await resp.json();
        if (data.status === 'ok') {
            if (data.must_change_pwd) {
                document.getElementById('forceNewPwd').value = '';
                document.getElementById('forceConfirmPwd').value = '';
                document.getElementById('forcePwdError').style.display = 'none';
                document.getElementById('forcePwdModal').style.display = 'flex';
            } else {
                window.location.href = '/admin';
            }
        } else {
            errorMsg.textContent = data.error || '登录失败';
            errorDiv.style.display = 'flex';
        }
    } catch (err) {
        errorMsg.textContent = '网络错误: ' + err.message;
        errorDiv.style.display = 'flex';
    }
});

// 强制修改密码提交
document.getElementById('forcePwdForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const newPwd = document.getElementById('forceNewPwd').value;
    const confirmPwd = document.getElementById('forceConfirmPwd').value;
    const errDiv = document.getElementById('forcePwdError');

    if (!newPwd || !confirmPwd) {
        errDiv.textContent = '密码不能为空';
        errDiv.style.display = 'block';
        return;
    }
    if (newPwd !== confirmPwd) {
        errDiv.textContent = '两次输入的密码不一致';
        errDiv.style.display = 'block';
        return;
    }
    if (newPwd.length < 8) {
        errDiv.textContent = '密码长度至少 8 位';
        errDiv.style.display = 'block';
        return;
    }
    if (!/[a-zA-Z]/.test(newPwd) || !/[0-9]/.test(newPwd)) {
        errDiv.textContent = '密码必须同时包含字母和数字';
        errDiv.style.display = 'block';
        return;
    }

    try {
        const resp = await fetch('/api/inner/user/password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old_pwd: document.getElementById('userPwd').value.trim(), new_pwd: newPwd })
        });
        const data = await resp.json();
        if (data.status === 'ok') {
            window.location.href = '/admin';
        } else {
            errDiv.textContent = data.error || '修改失败';
            errDiv.style.display = 'block';
        }
    } catch (err) {
        errDiv.textContent = '网络错误: ' + err.message;
        errDiv.style.display = 'block';
    }
});
