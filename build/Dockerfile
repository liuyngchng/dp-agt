# ============================================================================
# Stage 1 - build TypeScript from local source
# ============================================================================
FROM ubuntu:24.04 AS builder

ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
ARG http_proxy="$HTTP_PROXY"
ARG https_proxy="$HTTPS_PROXY"
ARG no_proxy="$NO_PROXY"

RUN if [ -n "$HTTP_PROXY" ]; then \
        echo 'Acquire::http::Proxy "'$HTTP_PROXY'";' > /etc/apt/apt.conf.d/01proxy; \
    fi; \
    if [ -n "$HTTPS_PROXY" ]; then \
        echo 'Acquire::https::Proxy "'$HTTPS_PROXY'";' >> /etc/apt/apt.conf.d/01proxy; \
    fi

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils \
    && rm -f /etc/apt/apt.conf.d/01proxy

# Node.js from local tarball
COPY deploy/node-v22.23.2-linux-x64.tar.xz /tmp/
RUN tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

WORKDIR /build
COPY package.json tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund
COPY src/ src/
RUN npm run build

# ============================================================================
# Stage 2 - final runtime image
# ============================================================================
FROM ubuntu:24.04

ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
ARG http_proxy="$HTTP_PROXY"
ARG https_proxy="$HTTPS_PROXY"
ARG no_proxy="$NO_PROXY"

RUN if [ -n "$HTTP_PROXY" ]; then \
        echo 'Acquire::http::Proxy "'$HTTP_PROXY'";' > /etc/apt/apt.conf.d/01proxy; \
    fi; \
    if [ -n "$HTTPS_PROXY" ]; then \
        echo 'Acquire::https::Proxy "'$HTTPS_PROXY'";' >> /etc/apt/apt.conf.d/01proxy; \
    fi

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai

# ---- System dependencies ----
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    ripgrep \
    sqlite3 \
    unzip \
    vim-tiny \
    xz-utils \
    && rm -f /etc/apt/apt.conf.d/01proxy

# ---- Node.js ----
COPY deploy/node-v22.23.2-linux-x64.tar.xz /tmp/
RUN tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

# ---- Runtime user ----
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -r -m -d /home/agent -u 1000 -s /bin/bash agent

USER agent
ENV HOME=/home/agent

# ---- Claude Code CLI ----
# When build.sh finds a host-installed claude binary, it copies it into
# deploy/claude-code/ and sets CLAUDE_CODE_OFFLINE=1 — offline install.
# Otherwise falls back to `npm install -g`.
ARG CLAUDE_CODE_OFFLINE=""
COPY --chown=agent:agent deploy/claude-code/ /tmp/claude-code/

# Offline path: use the host-provided binary
RUN if [ -n "$CLAUDE_CODE_OFFLINE" ] && [ -f /tmp/claude-code/claude ]; then \
      echo "Installing Claude Code CLI from local binary"; \
      mkdir -p /home/agent/.local/bin; \
      cp /tmp/claude-code/claude /home/agent/.local/bin/claude; \
      chmod +x /home/agent/.local/bin/claude; \
    fi

# Online fallback
RUN --mount=type=cache,target=/home/agent/.npm,uid=1000,gid=1000 \
    if [ -z "$CLAUDE_CODE_OFFLINE" ] || [ ! -f /tmp/claude-code/claude ]; then \
      echo "Claude Code CLI local binary not found, falling back to npm install"; \
      npm set prefix /home/agent/.local; \
      npm install -g @anthropic-ai/claude-code \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=20000 \
        --fetch-retry-maxtimeout=120000 \
        --fetch-timeout=600000 \
        --no-audit \
        --no-fund; \
    fi

RUN rm -rf /tmp/claude-code

ENV PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin

# ---- App ----
WORKDIR /app
COPY --chown=agent:agent --from=builder /build/dist/ /app/dist/
COPY --chown=agent:agent --from=builder /build/node_modules/ /app/node_modules/
COPY --chown=agent:agent package.json tsconfig.json /app/
COPY --chown=agent:agent web/ /app/web/
COPY --chown=agent:agent prompts/ /app/prompts/

# ---- 第2类静态资源（镜像内，不依赖宿主机挂载） ----
COPY --chown=agent:agent data/cfg.csv.template data/mock.json /app/assets/

# ---- 运行时工作目录（第3类：tasks/ + claude-config/，纯容器内 ephemeral） ----
# chmod 777 是因为 run.sh 通过 --user $HOST_UID 启动，UID 不固定
RUN mkdir -p /app/runtime && chmod 777 /app/runtime

# ---- HTTPS certs ----
# 证书直接打入镜像（不依赖宿主机挂载），chmod 644 保证任意 uid 可读
ARG HTTPS_CERT=""
COPY --chown=agent:agent deploy/certs/ /tmp/certs/
RUN if [ -n "$HTTPS_CERT" ] && [ -f /tmp/certs/cert.pem ]; then \
      mkdir -p /app/deploy/certs && \
      cp /tmp/certs/cert.pem /tmp/certs/key.pem /app/deploy/certs/ && \
      chmod 644 /app/deploy/certs/cert.pem /app/deploy/certs/key.pem; \
    fi && \
    rm -rf /tmp/certs

# ---- Runtime ----
WORKDIR /app
EXPOSE 20001

ENV DATA_DIR=/app/data

CMD ["node", "dist/index.js"]