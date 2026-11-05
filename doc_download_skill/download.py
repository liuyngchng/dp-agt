#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""doc_download_skill 下载脚本。

仅负责下载，不做任何文档解析、内容提取。

从输入 JSON（如 mock.json）中读取 files 数组，逐个下载：
  - file_type == "main_body"   -> 正文
  - file_type == "attachment"  -> 附件

输入来源三选一：
  1) -i 指定 JSON 文件
  2) --json 直接传 JSON 字符串
  3) 标准输入（stdin）
"""
import argparse
import json
import os
import re
import shutil
import ssl
import sys
import urllib.parse
import urllib.request

DEFAULT_TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "token.txt")


def log(msg):
    print(msg, file=sys.stderr)


def load_config_file(path):
    """读取 token.txt 配置文件。

    支持两种格式：
      1) key=value 配置（推荐）：
           doc.download.token=<bearer token>
           doc.renew_file_url_api=<WPS 续期接口地址>
      2) 纯 token：整个文件内容直接作为 bearer token。

    返回 (config_dict, token_str)。
    """
    cfg = {}
    if not path or not os.path.exists(path):
        return cfg, ""
    with open(path, "r", encoding="utf-8-sig") as f:
        raw = f.read()
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    token = cfg.get("doc.download.token") or cfg.get("doc.file_url_token") or ""
    if not token and not cfg.get("doc.renew_file_url_api"):
        # 不是 key=value 配置，按纯 token 处理
        token = raw.strip()
    return cfg, token


def normalize_token(raw):
    t = (raw or "").strip()
    if not t:
        return ""
    if t.lower().startswith("bearer "):
        return t
    return "Bearer " + t


def read_stdin():
    if sys.stdin.isatty():
        return ""
    data = sys.stdin.buffer.read()
    return data.decode("utf-8-sig") if data else ""


def load_input(args):
    if args.input:
        with open(args.input, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    if args.json:
        return json.loads(args.json)
    raw = read_stdin()
    return json.loads(raw) if raw.strip() else None


def extract_files(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if isinstance(data.get("files"), list):
            return data["files"]
        for k in ("data", "body", "request", "form_data", "payload"):
            v = data.get(k)
            if isinstance(v, dict) and isinstance(v.get("files"), list):
                return v["files"]
    return []


def filename_from_url(url):
    """优先从 URL 查询参数中的 content-disposition 解析文件名。"""
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    for key in ("response-content-disposition", "content-disposition"):
        if key not in qs:
            continue
        disp = qs[key][0]
        # RFC 5987: filename*=utf-8''...
        m = re.search(r"filename\*\s*=\s*([^;]+)", disp, re.I)
        if m:
            name = m.group(1).strip().strip('"')
            name = re.sub(r"^(?:utf-8|UTF-8)''", "", name)
            return urllib.parse.unquote(name)
        # 普通 filename="..."
        m = re.search(r"filename\s*=\s*\"?([^\";]+)", disp, re.I)
        if m:
            return urllib.parse.unquote(m.group(1).strip())
    path = urllib.parse.unquote(parsed.path)
    base = os.path.basename(path)
    return base or None


def sanitize_filename(name):
    name = (name or "").replace("\\", "/").split("/")[-1]
    for ch in '<>:"|?*':
        name = name.replace(ch, "_")
    name = name.strip().strip(".")
    return name or "file"


def pick_filename(item, url, fid, ftype, index):
    name = item.get("file_Name") or item.get("file_name") or item.get("fileName")
    if name:
        return sanitize_filename(name)
    name = filename_from_url(url)
    if name:
        return sanitize_filename(name)
    stem = fid or ftype or "file"
    return sanitize_filename(f"{stem}_{index}")


def unique_path(outdir, name):
    base, ext = os.path.splitext(name)
    dest = os.path.join(outdir, name)
    n = 1
    while os.path.exists(dest):
        dest = os.path.join(outdir, f"{base}_{n}{ext}")
        n += 1
    return dest


def build_opener(verify_ssl):
    # 内网直连，禁用系统代理
    handlers = [urllib.request.ProxyHandler({})]
    if not verify_ssl:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


def download(url, dest, token, verify_ssl):
    req = urllib.request.Request(url, headers={"User-Agent": "doc_download_skill/1.0"})
    if token:
        req.add_header("Authorization", token)
    opener = build_opener(verify_ssl)
    with opener.open(req, timeout=120) as resp:
        with open(dest, "wb") as f:
            shutil.copyfileobj(resp, f)
    return os.path.getsize(dest)


def renew_url(renew_api, fid, token, verify_ssl):
    """文件直连下载失败时，用 file_id 调 WPS 接口换取新下载 URL。

    返回新的 file_url 字符串；失败抛异常。
    """
    payload = json.dumps({"fileId": fid, "getFileUrlType": "download"}).encode("utf-8")
    req = urllib.request.Request(renew_api, data=payload,
                                 headers={
                                     "Content-Type": "application/json",
                                     "User-Agent": "doc_download_skill/1.0",
                                 })
    if token:
        req.add_header("Authorization", token)
    opener = build_opener(verify_ssl)
    with opener.open(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    url = body.get("data") if isinstance(body, dict) else None
    if not url:
        raise RuntimeError(f"renew_url 返回异常：{body}")
    return url


def main(argv=None):
    ap = argparse.ArgumentParser(description="下载电子公文正文与附件")
    ap.add_argument("-i", "--input", help="输入 JSON 文件路径")
    ap.add_argument("--json", dest="json_text", help="直接传入的 JSON 字符串")
    ap.add_argument("-o", "--outdir", default="downloads", help="输出目录（默认 ./downloads）")
    ap.add_argument("--token-file", default=DEFAULT_TOKEN_FILE,
                    help="Bearer token 文件（默认脚本同目录 token.txt）")
    ap.add_argument("--verify-ssl", action="store_true",
                    help="校验 HTTPS 证书（默认不校验，适配内网自签证书）")
    ap.add_argument("--renew-url", default="",
                    help="WPS 文件链接续期接口地址；file_url 直连下载失败时，用 file_id 调此接口获取新 URL 重试")
    args = ap.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    cfg, token = load_config_file(args.token_file)
    token = normalize_token(token)
    if not token:
        log("[warn] 未读取到 token（token.txt 为空），将以无认证方式下载")

    # renew_url 接口地址：命令行 --renew-url 优先，其次取配置文件的 doc.renew_file_url_api
    renew_api = args.renew_url or cfg.get("doc.renew_file_url_api") or ""

    data = load_input(args)
    if data is None:
        print(json.dumps({"code": 1, "message": "未获取到输入 JSON", "files": []},
                         ensure_ascii=False))
        return 1

    files = extract_files(data)
    if not files:
        print(json.dumps({"code": 1, "message": "输入 JSON 中未找到 files 数组", "files": []},
                         ensure_ascii=False))
        return 1

    os.makedirs(args.outdir, exist_ok=True)
    results = []
    for i, item in enumerate(files):
        if not isinstance(item, dict):
            continue
        url = item.get("file_url") or item.get("fileUrl") or item.get("url")
        fid = item.get("file_id") or item.get("fileId") or ""
        ftype = item.get("file_type") or item.get("fileType") or ""
        if not url:
            results.append({"file_id": fid, "file_type": ftype, "status": "failed",
                            "error": "缺少 file_url"})
            continue
        name = pick_filename(item, url, fid, ftype, i)
        dest = unique_path(args.outdir, name)
        errors = []
        try:
            size = download(url, dest, token, args.verify_ssl)
            results.append({
                "file_id": fid, "file_type": ftype, "file_name": name,
                "saved_path": os.path.abspath(dest), "size": size, "status": "ok",
            })
            log(f"[ok] {ftype or '-'} -> {dest} ({size} bytes)")
        except Exception as e:
            errors.append(f"直连下载失败: {e}")
            # 直连失败时，尝试用 file_id 走 WPS 续期接口换新 URL 重试
            if renew_api and fid:
                try:
                    new_url = renew_url(renew_api, fid, token, args.verify_ssl)
                    size = download(new_url, dest, token, args.verify_ssl)
                    results.append({
                        "file_id": fid, "file_type": ftype, "file_name": name,
                        "saved_path": os.path.abspath(dest), "size": size, "status": "ok",
                        "renewed": True,
                    })
                    log(f"[ok][renewed] {ftype or '-'} -> {dest} ({size} bytes)")
                    continue
                except Exception as re_err:
                    errors.append(f"renew_url 重试失败: {re_err}")
            results.append({"file_id": fid, "file_type": ftype, "file_name": name,
                            "status": "failed", "error": "; ".join(errors)})
            log(f"[failed] {name}: {'; '.join(errors)}")

    ok = sum(1 for r in results if r.get("status") == "ok")
    total = len(results)
    out = {
        "code": 0 if ok == total else 1,
        "message": f"下载完成：成功 {ok}/{total}",
        "total": total,
        "success": ok,
        "outdir": os.path.abspath(args.outdir),
        "files": results,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
