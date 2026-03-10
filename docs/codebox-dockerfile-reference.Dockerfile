# codebox — universal dev sandbox image
#
# A complete coding environment with multiple language runtimes,
# coding CLIs (Claude Code, Codex), and common developer tools.
# Used by VibeLab and other products as the base sandbox image.
#
# Build:
#   docker build -t codebox:latest .
#
# Multi-arch (push to registry):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/<org>/codebox:latest --push .

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# ── System packages ─────────────────────────────────────────────
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
      # Shell & terminal
      tmux zsh \
      # Editors
      vim nano \
      # Dev tools
      git curl wget jq htop tree make \
      build-essential pkg-config \
      # Python 3
      python3 python3-pip python3-venv python3-dev \
      # Search tools
      ripgrep fd-find \
      # Networking & security
      ca-certificates gnupg openssh-client \
      # Misc
      less unzip xz-utils \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && ln -sf /usr/bin/fdfind /usr/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# ── GitHub CLI ──────────────────────────────────────────────────
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update -qq && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# ── Go ──────────────────────────────────────────────────────────
ARG GO_VERSION=1.23.6
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
      | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# ── Bun ─────────────────────────────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# ── uv (fast Python package manager) ───────────────────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# ── Claude Code ─────────────────────────────────────────────────
RUN npm install -g @anthropic-ai/claude-code

# ── Codex CLI (platform binary may not exist for all arches) ────
RUN npm install -g @openai/codex@latest; \
    ARCH=$(uname -m); \
    if [ "$ARCH" = "aarch64" ]; then \
      npm install -g @openai/codex-linux-arm64 2>/dev/null || true; \
    elif [ "$ARCH" = "x86_64" ]; then \
      npm install -g @openai/codex-linux-x64 2>/dev/null || true; \
    fi

# ── Cleanup ─────────────────────────────────────────────────────
RUN npm cache clean --force && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /root
