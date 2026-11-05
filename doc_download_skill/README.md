# doc_download_skill

给办公智能体（workbuddy 等）加载的下载技能：读取用户提供的 JSON 数据，读取其中的 URL 链接地址进行下载。只做下载，不做解析。

## 文件说明

| 文件 | 作用 |
|------|------|
| `SKILL.md` | 技能定义与使用说明（给办公智能体读） |
| `download.py` | 下载脚本（仅用 Python 3 标准库，无需安装第三方依赖） |
| `token.txt` | 配置文件（key=value）：`doc.download.token`（bearer token）、`doc.renew_file_url_api`（续期接口地址） |
| `README.md` | 本说明 |

## 使用步骤

1. 把整个 `doc_download_skill` 目录放到办公智能体的 skills 目录下（具体路径见该智能体的 skills 加载说明）。
2. 编辑 `token.txt`，按 key=value 格式填写：

```
doc.download.token=<bearer token>
doc.renew_file_url_api=<WPS 续期接口地址>
```

3. 办公智能体按 `SKILL.md` 中的命令调用 `download.py` 即可。

## 手动测试

```bash
python download.py -i mock.json -o ./downloads
```

输出为 JSON，`code == 0` 表示全部下载成功，各文件的保存路径见 `files[].saved_path`。
