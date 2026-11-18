#!/usr/bin/env bash
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="/etc/systemd/system"

install -m 0644 "$src/opencode-serve.service" "$dest/opencode-serve.service"
install -m 0644 "$src/atme-proxy.service" "$dest/atme-proxy.service"

systemctl daemon-reload
systemctl enable --now opencode-serve.service
systemctl enable --now atme-proxy.service

systemctl --no-pager --full status opencode-serve.service atme-proxy.service || true
