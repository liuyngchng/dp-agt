#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------
#  get_doc.sh
#   1) 读取脚本同目录下的 info.txt : 第 1 行 = renew_url, 第 2 行 = token
#   2) file_id : 优先用命令行参数 $1，否则交互输入
#   3) POST 获取新的下载 URL（响应 JSON 的 data 字段）
#   4) GET 下载文件到当前目录
#   所有请求: 忽略 SSL 证书 (-k) 且绕过代理 (--noproxy "*")
# ---------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFO_FILE="${SCRIPT_DIR}/info.txt"

# (1) 读取 info.txt
if [[ ! -f "${INFO_FILE}" ]]; then
  echo "[ERROR] 找不到 info.txt（脚本同目录下）。"
  exit 1
fi

REQ_URL="$(sed -n '1p' "${INFO_FILE}" | tr -d '\r')"
TOKEN="$(sed -n '2p' "${INFO_FILE}" | tr -d '\r')"

if [[ -z "${REQ_URL}" ]]; then
  echo "[ERROR] info.txt 第 1 行（renew_url）为空。"
  exit 1
fi
if [[ "${REQ_URL}" != http://* && "${REQ_URL}" != https://* ]]; then
  echo "[ERROR] info.txt 第 1 行（renew_url）不是有效的 http/https 地址，请检查是否与 token 顺序填反。"
  exit 1
fi
if [[ -z "${TOKEN}" ]]; then
  echo "[ERROR] info.txt 第 2 行（token）为空。"
  exit 1
fi

# 回显 info.txt 内容
echo "----- info.txt -----"
sed -n '1,2p' "${INFO_FILE}"
echo "---------------------"

# (2) 获取 file_id
FILE_ID="${1:-}"
if [[ -z "${FILE_ID}" ]]; then
  read -r -p "Enter file_id: " FILE_ID
fi
if [[ -z "${FILE_ID}" ]]; then
  echo "[ERROR] file_id 为空。"
  exit 1
fi

# (3) POST 获取下载 URL
if ! command -v python >/dev/null 2>&1; then
  echo "[ERROR] 需要 python 用于解析响应 JSON。"
  exit 1
fi

BODY="{\"fileId\":\"${FILE_ID}\",\"getFileUrlType\":\"download\"}"

echo
echo "[POST] ${REQ_URL}"

RESP="$(curl -s -k --noproxy '*' -X POST "${REQ_URL}" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "${BODY}")"

echo
echo "[POST response]"
echo "${RESP}"

# (4) 解析 data（下载 URL）和文件名
OUT="$(printf '%s' "${RESP}" | python -c '
import sys, json, re, urllib.parse
d = json.load(sys.stdin)
url = d.get("data") or ""
if not url:
    sys.exit(0)
dec = urllib.parse.unquote(url)
m = re.search(r"filename\*=utf-8\x27\x27([^&]+)", dec, re.I) or \
    re.search(r"filename\*=([^&]+)", dec, re.I) or \
    re.search(r"filename=([^&]+)", dec, re.I)
print(url)
print(m.group(1).strip("\"") if m else "")
')"

DOWNLOAD_URL="$(printf '%s\n' "${OUT}" | sed -n '1p')"
FNAME="$(printf '%s\n' "${OUT}" | sed -n '2p')"

if [[ -z "${DOWNLOAD_URL}" ]]; then
  echo "[ERROR] 响应中无 data 字段。"
  exit 1
fi
if [[ -z "${FNAME}" ]]; then
  echo "[ERROR] 无法从下载地址解析文件名。"
  exit 1
fi

# (5) 下载
echo
echo "下载到 ${FNAME} ..."
curl -s -k --noproxy '*' -L -X GET -o "${FNAME}" "${DOWNLOAD_URL}"

echo
echo "[Done] ${FNAME}"
