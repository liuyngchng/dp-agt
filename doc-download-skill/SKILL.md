---
name: doc-download-skill
description: 下载电子公文正文与附件。当输入数据（JSON）含 files 数组，需要把正文（file_type=main_body）和附件（file_type=attachment）下载到本地时使用。仅下载，不做解析。 
---

# 文档下载（doc_download_skill）

从输入 JSON 中读取 `files` 数组，下载其中的**正文**（`file_type == "main_body"`）和**附件**（`file_type == "attachment"`）到本地目录。只做下载，不做任何文档解析或内容提取。

## 前置条件

1. 本机需安装 Python 3。
2. 已在 `token.txt` 配置文件中填写 token 和续期接口地址（key=value 格式）：

```
doc.download.token=<bearer token>
doc.renew_file_url_api=<WPS 续期接口地址>
```

- `doc.download.token`：下载/续期接口的 Bearer token（纯 token，无需 `Bearer ` 前缀）。
- `doc.renew_file_url_api`：WPS 文件链接续期接口地址，用于 `file_url` 直连下载失败时回退。留空则不启用回退。

## 输入

输入 JSON 结构类似 `mock.json`，关键字段是 `files` 数组：

```json
{
  "files": [
    { "file_url": "https://...", "file_type": "main_body", "file_id": "..." },
    { "file_url": "https://...", "file_type": "attachment", "file_id": "...", "file_Name": "示例附件.pdf" }
  ]
}
```

也支持 `files` 位于 `data` / `body` / `request` / `form_data` 下一层，或输入直接是 files 数组。

## 执行

先切换到本 skill 目录，再运行 `download.py`：

```bash
python download.py -i <输入json文件> -o <输出目录>
```

输入也可以来自标准输入或 `--json`：

```bash
echo '<JSON>' | python download.py -o <输出目录>
python download.py --json '<JSON>' -o <输出目录>
```

若 `python` 命令不可用，改用 `py`。

### 参数

| 参数 | 说明 |
|------|------|
| `-i, --input` | 输入 JSON 文件路径 |
| `--json` | 直接传入的 JSON 字符串 |
| `-o, --outdir` | 输出目录（默认 `./downloads`） |
| `--token-file` | token 配置文件路径（默认脚本同目录 `token.txt`） |
| `--verify-ssl` | 校验 HTTPS 证书（默认不校验，适配内网自签证书） |
| `--renew-url` | 覆盖配置文件里的续期接口地址；`file_url` 直连下载失败时，用 `file_id` 调此接口获取新 URL 重试 |

## 下载失败回退（renew_url）

当 `file_url` 直连下载失败（超时、403、连接被拒等）时，脚本会自动用 `file_id` 调用 WPS 接口换取新下载链接后重试，无需智能体额外执行 curl。

续期接口地址在 `token.txt` 配置文件中声明（或通过 `--renew-url` 传入），请求体固定为 `{"fileId": "<file_id>", "getFileUrlType": "download"}`，认证头沿用配置的 token，返回 JSON 中的 `data` 字段即新下载 URL。

## 输出

标准输出为一段 JSON（UTF-8），列出每个文件的下载结果与保存路径：

```json
{
  "code": 0,
  "message": "下载完成：成功 2/2",
  "total": 2,
  "success": 2,
  "outdir": "...",
  "files": [
    { "file_id": "...", "file_type": "main_body", "file_name": "...", "saved_path": "...", "size": 12345, "status": "ok" }
  ]
}
```

`code == 0` 表示全部成功；否则 `code == 1`，查看 `files[].error`。

## 注意事项

- 仅下载，不解析文档内容、不提取文本。

- 下载文件名优先级：`file_Name` 字段 > URL 中的 filename > file_id 兜底。

- 默认禁用系统代理直连内网、忽略 HTTPS 证书校验（内网自签证书场景）。

- 若 `token.txt` 为空，则以无认证方式下载。

- 若python脚本本身有问题，请自行修改调整。我这里给一个 下载文件的curl示范


```
curl -X POST "https://your_file_download_file" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_bearer_token" \
  -d '{
    "fileId": "409745446043652",
    "getFileUrlType": "download"
  }'
```

  
