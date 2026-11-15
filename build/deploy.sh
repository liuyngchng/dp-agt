#!/usr/bin/env bash
# AI 数字员工 — 集群部署脚本（微服务模式，每服务一台机器）
#
# 用法:
#   ./build/deploy.sh up control              # 在本机启动控制面
#   ./build/deploy.sh up runner               # 在本机启动 runner
#   ./build/deploy.sh down control            # 停止控制面
#   ./build/deploy.sh down runner             # 停止 runner
#   ./build/deploy.sh restart [control|runner] # 重启
#   ./build/deploy.sh logs [control|runner]   # 查看日志
#   ./build/deploy.sh ps [control|runner]     # 查看容器状态
#   ./build/deploy.sh gen-token               # 生成 RUNNER_TOKEN 并写入 data/.runner-env
#
# 环境变量（均可被同名环境变量覆盖）:
#   IMAGE_TAG   镜像版本（默认取 package.json 的 version）
#   HOST_PORT   控制面对外端口（默认 20001）
#   RUNNER_PORT runner 监听端口（默认 20002）
#   RUNNER_MAX_CONCURRENT  单 runner 最大并发（默认 5）
set -euo pipefail

# 切换到项目根目录（本脚本位于 build/ 下）
cd "$(dirname "$0")/.."

ENV_FILE="data/.runner-env"

# ── 工具函数 ────────────────────────────────────────────────────
msg()  { printf '\n\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

pkg_version() {
  node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null || echo "0.1.0"
}

load_env() {
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
  fi
}

require_token() {
  if [ -z "${RUNNER_TOKEN:-}" ]; then
    die "RUNNER_TOKEN 未设置。请先执行 ./build/deploy.sh gen-token 生成，或手动 export RUNNER_TOKEN=xxx"
  fi
}

require_image() {
  local tag="${IMAGE_TAG:-latest}"
  if ! docker image inspect "dp-agt:$tag" >/dev/null 2>&1; then
    die "镜像 dp-agt:$tag 不存在。请执行 ./build/build.sh 构建镜像，或将镜像推送到本机 registry。"
  fi
}

resolve_compose() {
  local role="$1"
  case "$role" in
    control)  echo "build/compose.control.yml" ;;
    runner)   echo "build/compose.runner.yml" ;;
    *)
      die "未知角色: '$role'。可选: control | runner"
      ;;
  esac
}

# ── 子命令 ──────────────────────────────────────────────────────
cmd_gen_token() {
  if [ -f "$ENV_FILE" ] && grep -q '^RUNNER_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    warn "$ENV_FILE 已存在 RUNNER_TOKEN，跳过生成"
    cat "$ENV_FILE"
    return 0
  fi
  local token
  token=$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  mkdir -p data
  printf 'RUNNER_TOKEN=%s\n' "$token" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  msg "已生成 RUNNER_TOKEN 并写入 $ENV_FILE（权限 600）"
  echo ""
  echo "  该文件会被 deploy.sh 自动加载。跨机器部署时，请把此 token 复制到"
  echo "  所有 runner 服务器上（data/.runner-env），确保控制面与所有 runner 一致。"
  echo ""
  cat "$ENV_FILE"
}

cmd_up() {
  local role="${1:-}"
  [ -z "$role" ] && die "用法: ./build/deploy.sh up <control|runner>"
  local compose_file
  compose_file=$(resolve_compose "$role")
  load_env
  require_token
  require_image

  export HOST_UID="${HOST_UID:-$(id -u)}"
  export HOST_GID="${HOST_GID:-$(id -g)}"
  export IMAGE_TAG="${IMAGE_TAG:-latest}"
  export HOST_PORT="${HOST_PORT:-20001}"
  export RUNNER_PORT="${RUNNER_PORT:-20002}"
  export RUNNER_MAX_CONCURRENT="${RUNNER_MAX_CONCURRENT:-5}"
  export RUNNER_TIMEOUT_MS="${RUNNER_TIMEOUT_MS:-600000}"
  export RUNNER_GRACE_MS="${RUNNER_GRACE_MS:-60000}"

  local host_ip
  host_ip=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

  msg "启动 $role (镜像 dp-agt:$IMAGE_TAG)"
  docker-compose -f "$compose_file" up -d

  case "$role" in
    control)
      echo "  控制面:    https://$host_ip:${HOST_PORT}"
      echo "  健康检查:  https://$host_ip:${HOST_PORT}/health"
      echo ""
      echo "  ⚠ 自签证书，浏览器请点\"高级\"→\"继续访问\""
      echo ""
      echo "  ⚠ 请确认 data/cfg.yml 中 runner.addresses 已填写各 runner 的实际 IP:"
      awk '/^runner:/,0' data/cfg.yml 2>/dev/null | grep -A10 'addresses:' || true
      ;;
    runner)
      echo "  runner:     https://$host_ip:${RUNNER_PORT}"
      echo "  /status:    https://$host_ip:${RUNNER_PORT}/status"
      echo "  并发上限:   $RUNNER_MAX_CONCURRENT"
      echo ""
      echo "  ⚠ 请确认这台 runner 的 IP 已加到控制面 data/cfg.yml 的 runner.addresses 中"
      ;;
  esac
}

cmd_down() {
  local role="${1:-}"
  [ -z "$role" ] && die "用法: ./build/deploy.sh down <control|runner>"
  local compose_file
  compose_file=$(resolve_compose "$role")
  load_env
  export IMAGE_TAG="${IMAGE_TAG:-latest}"
  export HOST_PORT="${HOST_PORT:-20001}"
  export RUNNER_PORT="${RUNNER_PORT:-20002}"

  msg "停止并移除 $role 容器"
  docker-compose -f "$compose_file" down
}

cmd_restart() {
  local role="${1:-}"
  [ -z "$role" ] && die "用法: ./build/deploy.sh restart <control|runner>"
  local compose_file
  compose_file=$(resolve_compose "$role")
  load_env
  export IMAGE_TAG="${IMAGE_TAG:-latest}"
  export HOST_PORT="${HOST_PORT:-20001}"
  export RUNNER_PORT="${RUNNER_PORT:-20002}"

  msg "重启 $role"
  docker-compose -f "$compose_file" restart
}

cmd_logs() {
  local role="${1:-}"
  [ -z "$role" ] && die "用法: ./build/deploy.sh logs <control|runner>"
  local compose_file
  compose_file=$(resolve_compose "$role")
  load_env
  docker-compose -f "$compose_file" logs -f --tail=100
}

cmd_ps() {
  local role="${1:-}"
  if [ -z "$role" ]; then
    # 显示全部角色的 compose 状态
    local found=false
    for f in build/compose.control.yml build/compose.runner.yml; do
      if [ -f "$f" ]; then
        echo "=== $f ==="
        docker-compose -f "$f" ps 2>/dev/null || echo "  (未运行)"
        found=true
      fi
    done
    $found || echo "未找到 compose 文件"
  else
    local compose_file
    compose_file=$(resolve_compose "$role")
    docker-compose -f "$compose_file" ps
  fi
}

# ── 入口 ────────────────────────────────────────────────────────
cmd="${1:-}"
shift || true
case "$cmd" in
  up)        cmd_up "$@" ;;
  down)      cmd_down "$@" ;;
  restart)   cmd_restart "$@" ;;
  logs)      cmd_logs "$@" ;;
  ps|status) cmd_ps "$@" ;;
  gen-token) cmd_gen_token ;;
  -h|--help|help)
    sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "用法: $0 [up|down|restart|logs|ps] <control|runner>" >&2
    echo "      $0 gen-token" >&2
    exit 1
    ;;
esac