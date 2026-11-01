#!/usr/bin/env bash
# AI 数字员工 deploy script
# Usage: ./deploy.sh [start|stop|restart|logs|status]
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="ai-worker:0.1.0"
CONTAINER="${CONTAINER:-ai-worker}"
HOST_PORT="${HOST_PORT:-20001}"
DATA_DIR="${DATA_DIR:-$(pwd)/data}"
NETWORK="${NETWORK:-llm_net}"

echo "ensure data dir exists"
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/tasks" "$DATA_DIR/logs" "$DATA_DIR/.claude"
echo "detect host uid/gid"
# Detect host UID/GID (use current user to match data dir ownership)
HOST_UID=$(id -u)
HOST_GID=$(id -g)

echo "check cfg.yml"
if [ ! -f "$DATA_DIR/cfg.yml" ]; then
  echo "[deploy] cfg.yml 不存在，从模板复制..."
  cp "$(pwd)/data/cfg.yml.template" "$DATA_DIR/cfg.yml"
  echo "[deploy] 请编辑 $DATA_DIR/cfg.yml 后再启动"
fi

echo "check cfg.csv.template"
if [ ! -f "$DATA_DIR/cfg.csv.template" ]; then
  cp "$(pwd)/data/cfg.csv.template" "$DATA_DIR/cfg.csv.template"
  echo "[deploy] cfg.csv.template 已复制到数据目录"
fi

echo "ensure network exists"
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "[deploy] Creating network: $NETWORK"
  docker network create "$NETWORK"
fi

echo "detect local IP"
LOCAL_IP=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi

case "${1:-start}" in
  start)
    echo "check if image exists"
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "[deploy] Image not found. Run ./build/build.sh first."
      exit 1
    fi

    echo "stop existing container if running"
    if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      docker stop "$CONTAINER" 2>/dev/null || true
      docker rm "$CONTAINER" 2>/dev/null || true
    fi

    echo "[deploy] Starting container: $CONTAINER"
    docker run -d \
      --name "$CONTAINER" \
      --user "$HOST_UID:$HOST_GID" \
      --network "$NETWORK" \
      -p "$HOST_PORT:20001" \
      -v "$DATA_DIR:/app/data" \
      -v "$DATA_DIR/.claude:/home/agent/.claude" \
      --restart unless-stopped \
      --add-host api.anthropic.com:127.0.0.1 \
      --add-host api-staging.anthropic.com:127.0.0.1 \
      --add-host anthropic.com:127.0.0.1 \
      --add-host www.anthropic.com:127.0.0.1 \
      --add-host claude.ai:127.0.0.1 \
      --add-host claude.com:127.0.0.1 \
      --add-host platform.claude.com:127.0.0.1 \
      --add-host code.claude.com:127.0.0.1 \
      --add-host downloads.claude.ai:127.0.0.1 \
      --add-host docs.anthropic.com:127.0.0.1 \
      --add-host status.anthropic.com:127.0.0.1 \
      --add-host status.claude.com:127.0.0.1 \
      --add-host support.anthropic.com:127.0.0.1 \
      --add-host support.claude.com:127.0.0.1 \
      --add-host mcp-proxy.anthropic.com:127.0.0.1 \
      --add-host microsoft365.mcp.claude.com:127.0.0.1 \
      --add-host slack.mcp.claude.com:127.0.0.1 \
      --add-host api.datadoghq.com:127.0.0.1 \
      --add-host browser-intake-us5-datadoghq.com:127.0.0.1 \
      --add-host http-intake.logs.us5.datadoghq.com:127.0.0.1 \
      --add-host mcp.amplitude.com:127.0.0.1 \
      --add-host mcp.intercom.com:127.0.0.1 \
      --add-host mcp.sentry.dev:127.0.0.1 \
      --add-host telemetry.googleapis.com:127.0.0.1 \
      "$IMAGE"
    # 检查容器内是否含证书，决定用 http 还是 https
    PROTO="http"
    if docker exec "$CONTAINER" test -f /app/deploy/certs/cert.pem 2>/dev/null; then
      PROTO="https"
    fi

    echo "[deploy] 等待服务启动（最多 30 秒）..."
    echo ""
    if [ -n "$LOCAL_IP" ]; then
      echo "  管理后台:  $PROTO://$LOCAL_IP:$HOST_PORT"
      echo "  健康检查:  $PROTO://$LOCAL_IP:$HOST_PORT/health"
      echo "  业务接口:  POST $PROTO://$LOCAL_IP:$HOST_PORT/api/v1/<path>"
    else
      echo "  管理后台:  $PROTO://localhost:$HOST_PORT"
      echo "  健康检查:  $PROTO://localhost:$HOST_PORT/health"
      echo "  业务接口:  POST $PROTO://localhost:$HOST_PORT/api/v1/<path>"
    fi
    echo ""
    echo "  (自签证书，浏览器访问请点\"高级\"→\"继续\")"
    echo ""

    # 等待就绪，最终 tail -f 持续输出
    STARTED=0
    for ((i = 0; i < 30; i++)); do
      if docker logs "$CONTAINER" 2>&1 | grep -qE 'server_started_(http|https)'; then
        STARTED=1
        break
      fi
      sleep 1
    done

    if [ "$STARTED" -eq 1 ]; then
      echo "[deploy] ✓ 服务已启动（端口 $HOST_PORT），Ctrl+C 退出日志..."
    else
      echo "[deploy] ⚠ 30 秒内未检测到启动完成，继续等待..."
    fi
    echo ""
    docker logs -f --tail=0 "$CONTAINER"
    ;;

  stop)
    echo "[deploy] Stopping container: $CONTAINER"
    docker stop "$CONTAINER" || true
    docker rm "$CONTAINER" || true
    echo "[deploy] Stopped"
    ;;

  restart)
    "$0" stop
    "$0" start
    ;;

  logs)
    docker logs -f --tail=100 "$CONTAINER"
    ;;

  status)
    if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      echo "Container: $CONTAINER"
      docker inspect "$CONTAINER" --format 'Status: {{.State.Status}} | Port: {{(index .NetworkSettings.Ports "20001/tcp" 0).HostPort}} | Started: {{.State.StartedAt}}'
    else
      echo "Container not running"
    fi
    ;;

  *)
    echo "Usage: $0 [start|stop|restart|logs|status]"
    exit 1
    ;;
esac
