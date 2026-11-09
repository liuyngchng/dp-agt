## 文件下载回退（WPS 接口）

如果通过请求中的 `file_url` 直接下载文件失败（超时、403、连接被拒等），
可以尝试通过 WPS 接口用 `file_id` 重新获取新的下载链接。

接口令牌通过环境变量 `FILE_URL_TOKEN` 提供，**不要在日志或屏幕上输出此 Token**。

```bash
curl -s -k --noproxy '*' -w'\n' -X POST "${DP_DOC_RENEW_FILE_URL_API}" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${FILE_URL_TOKEN}" \
  -d '{"fileId": "<文件ID>", "getFileUrlType": "download"}' | jq -r '.data'
```

步骤：
1. 从请求 JSON 的 `files[].file_id` 字段获取文件 ID
2. 用上述命令获取新下载 URL（`jq -r '.data'` 返回的就是 file_url）
3. 用新的 URL 重新 curl 下载文件
4. 如果仍然失败，标记 `need_human: true` 并在 `fail_reason` 中说明原因