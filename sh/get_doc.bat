@echo off
setlocal enabledelayedexpansion

rem ---------------------------------------------------------------
rem  get_doc.bat
rem   1) 读取脚本同目录下的 info.txt : 第 1 行 = renew_url, 第 2 行 = token
rem   2) file_id : 优先用命令行参数 %1，否则交互输入
rem   3) POST 获取新的下载 URL（响应 JSON 的 data 字段）
rem   4) GET 下载文件到当前目录
rem   所有请求: 忽略 SSL 证书 (-k) 且绕过代理 (--noproxy "*")
rem ---------------------------------------------------------------

set "INFO_FILE=%~dp0info.txt"

rem (1) 读取 info.txt
if not exist "%INFO_FILE%" (
    echo [ERROR] 找不到 info.txt（脚本同目录下）。
    exit /b 1
)

set "N=0"
set "REQ_URL="
set "TOKEN="
for /f "usebackq delims=" %%a in ("%INFO_FILE%") do (
    set /a N+=1
    if "!N!"=="1" set "REQ_URL=%%a"
    if "!N!"=="2" set "TOKEN=%%a"
)

rem 回显 info.txt 内容
echo ----- info.txt -----
type "%INFO_FILE%"
echo ---------------------

rem 校验
if not defined REQ_URL (
    echo [ERROR] info.txt 第 1 行（renew_url）为空。
    exit /b 1
)
if /I not "!REQ_URL:~0,4!"=="http" (
    echo [ERROR] info.txt 第 1 行（renew_url）不是有效的 http/https 地址，请检查是否与 token 顺序填反。
    exit /b 1
)
if not defined TOKEN (
    echo [ERROR] info.txt 第 2 行（token）为空。
    exit /b 1
)

rem (2) 获取 file_id
set "FILE_ID=%~1"
if not defined FILE_ID (
    set /p FILE_ID=Enter file_id:
)
if not defined FILE_ID (
    echo [ERROR] file_id 为空。
    exit /b 1
)

rem (3) POST 获取下载 URL
set "BODY={"fileId":"!FILE_ID!","getFileUrlType":"download"}"
> _body.json echo !BODY!

echo.
echo [POST] !REQ_URL!

curl -s -k --noproxy "*" -X POST "!REQ_URL!" -H "Content-Type: application/json" -H "Authorization: Bearer !TOKEN!" -d @_body.json -o _resp.json

echo.
echo [POST response]
type _resp.json
echo.

rem (4) 解析 data（下载 URL）和文件名
powershell -NoProfile -Command "$j = ConvertFrom-Json ([System.IO.File]::ReadAllText('_resp.json', [System.Text.Encoding]::UTF8)); if (-not $j.data) { Write-Error 'no data field in response'; exit 1 }; [System.IO.File]::WriteAllText('_url.txt', $j.data, [System.Text.Encoding]::ASCII); $dec = [System.Uri]::UnescapeDataString([string]$j.data); $f = $null; if ($dec -match \"filename\*=utf-8''([^&]+)\") { $f = $matches[1] } elseif ($dec -match 'filename\*=([^&]+)') { $f = $matches[1] } elseif ($dec -match 'filename=([^&]+)') { $f = $matches[1].Trim('\"') }; if ($f) { [System.IO.File]::WriteAllText('_fname.txt', $f, [System.Text.Encoding]::ASCII) } else { Write-Error 'no filename in response'; exit 1 }"
if errorlevel 1 (
    echo [ERROR] 无法从响应中解析下载地址或文件名。
    exit /b 1
)

set /p DOWNLOAD_URL=<"_url.txt"
set /p FNAME=<"_fname.txt"
if not defined DOWNLOAD_URL (
    echo [ERROR] 下载地址为空。
    exit /b 1
)
if not defined FNAME (
    echo [ERROR] 文件名为空。
    exit /b 1
)

rem (5) 下载
echo.
echo 下载到 !FNAME! ...
curl -s -k --noproxy "*" -L -X GET -o "!FNAME!" "!DOWNLOAD_URL!"

echo.
echo [Done] !FNAME!
del _body.json _resp.json _url.txt _fname.txt 2>nul
endlocal
