#!/usr/bin/env bash
set -euo pipefail

src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="${ATME_REPO_DIR:-$(cd "$src_dir/../.." && pwd)}"
dest="/etc/systemd/system"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "请用 sudo 运行：sudo bash $0" >&2
  exit 1
fi

service_user="${ATME_SERVICE_USER:-${SUDO_USER:-root}}"
if ! id "$service_user" >/dev/null 2>&1; then
  echo "用户不存在：$service_user（可用 ATME_SERVICE_USER 指定）" >&2
  exit 1
fi
home_dir="$(getent passwd "$service_user" | cut -d: -f6)"
home_dir="${home_dir:-/root}"

node_bin="${ATME_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" ]]; then
  node_bin="$(ls -1 "$home_dir"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1 || true)"
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo "找不到 node。请用 ATME_NODE_BIN 指定绝对路径。" >&2
  exit 1
fi

opencode_bin="${ATME_OPENCODE_BIN:-$(command -v opencode || true)}"
if [[ -z "$opencode_bin" && -x "$home_dir/.opencode/bin/opencode" ]]; then
  opencode_bin="$home_dir/.opencode/bin/opencode"
fi
if [[ -z "$opencode_bin" || ! -x "$opencode_bin" ]]; then
  echo "找不到 opencode。请用 ATME_OPENCODE_BIN 指定绝对路径。" >&2
  exit 1
fi

if [[ ! -f "$repo_dir/dist/cli.js" ]]; then
  echo "缺少 $repo_dir/dist/cli.js，请先在仓库执行 npm run build。" >&2
  exit 1
fi

node_dir="$(dirname "$node_bin")"
opencode_dir="$(dirname "$opencode_bin")"

cat > "$dest/opencode-serve.service" <<EOF
[Unit]
Description=OpenCode headless server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$service_user
WorkingDirectory=$repo_dir
Environment=HOME=$home_dir
Environment=PATH=$node_dir:$opencode_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$opencode_bin serve --hostname 127.0.0.1 --port 19876
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

cat > "$dest/atme-proxy.service" <<EOF
[Unit]
Description=opencode-atme-proxy Feishu bot
After=network-online.target opencode-serve.service
Wants=network-online.target opencode-serve.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$service_user
WorkingDirectory=$repo_dir
Environment=HOME=$home_dir
Environment=PATH=$node_dir:$opencode_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$node_bin $repo_dir/dist/cli.js start
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now opencode-serve.service
systemctl enable --now atme-proxy.service
systemctl --no-pager --full status opencode-serve.service atme-proxy.service || true
