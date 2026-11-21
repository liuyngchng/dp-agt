## 文件下载（WPS 接口）

文件下载统一通过 WPS 接口：用 `file_id` 重新生成新的下载 URL，再用新 URL 下载。
**不要直接使用请求 JSON 中的 `file_url`** —— 该地址可能已过期（预签名 `X-Amz-Expires` 通常只有 15 分钟），直接下载会 403。

接口令牌通过环境变量 `FILE_URL_TOKEN` 提供，**不要在日志或屏幕上输出此 Token**。

第一步，用 `file_id` 获取新的下载 URL：

```bash
curl -s -k --noproxy '*' -w'\n' -X POST "${DP_DOC_RENEW_FILE_URL_API}" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${FILE_URL_TOKEN}" \
  -d '{"fileId": "<文件ID>", "getFileUrlType": "download"}' | jq -r '.data'
```

第二步，用新 URL 下载文件。**不要加 `Authorization: Bearer` 请求头** ——
新 URL 是预签名地址，URL 已自带 `X-Amz-Signature` 等认证参数，再叠加 Token 头会导致签名校验失败（400/403）：

```bash
curl -s -k --noproxy '*' -w'\n' '<新的下载URL>' -o 文件名
```

步骤：
1. 从请求 JSON 的 `files[].file_id` 字段获取文件 ID
2. 用第一步的命令获取新下载 URL（`jq -r '.data'` 返回的就是下载地址）
3. 用第二步的命令下载文件（不加 Authorization 头）
4. 如果失败，标记 `need_human: true` 并在 `fail_reason` 中说明原因
