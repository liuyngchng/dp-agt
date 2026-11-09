## 结果回调

无论任务成功还是失败（包括文件下载失败、服务不可达、DNS 解析失败等任何异常），
在输出最终 JSON 结果**之前**，**都必须**先执行下面的回调，把结果 POST 给调用方。
严禁因为预判回调可能失败而跳过这一步——哪怕你预期网络不通，也必须实际执行 curl 尝试。

接口令牌通过环境变量 `CALLBACK_TOKEN` 提供，**不要在日志或屏幕上输出此 Token**。
回调体中的 `task_id` 和 `linkid` 字段值，以你任务提示词中明确给出的准确值为准，不要猜测。

将 JSON 结果写入临时文件后发送：

```bash
# 构建回调体（替换 <你的结果JSON> 以及 task_id / linkid）
cat > /tmp/callback_payload.json << 'PAYLOAD_EOF'
{"code":0,"message":"success","task_id":"<任务提示词中的task_id>","linkid":"<任务提示词中的linkid>","data":<你的结果JSON>}
PAYLOAD_EOF

curl -s -k --noproxy '*' -w'\n' -X POST "${DP_CALLBACK_URL}" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
  -d @/tmp/callback_payload.json
```

- 回调成功（HTTP 2xx）→ 再输出最终 JSON
- 回调失败（非 2xx 或 curl 报错）→ 重试最多 3 次，间隔 2/4/8 秒
- 三次均失败后：在最终 JSON 的 `fail_reason` 中补充「结果回调失败：<最后错误信息>」，`need_human` 设为 `true`
- 若 `CALLBACK_TOKEN` 为空则跳过 Authorization 头
