#!/usr/bin/env bash
# ============================================================
# 自愈式 GitHub push
#
# 背景：本机走 Clash fake-ip 透明代理时，github.com / ssh.github.com
# 会被解析成 198.18.x.x fake-ip。若代理规则命中了一个失效节点，
# TCP 能连上（代理自己 accept），但 TLS/SSH 握手会 5s 超时并被重置：
#   kex_exchange_identification: Connection closed by remote host
#   Connection closed by 198.18.0.24 port 443
#
# 实测结论（见 docs/10-network-diagnostics.md）：
#   - 连真实 IP 且不带 SNI → 直连成功
#   - dns.alidns.com 的 DoH → 走 DIRECT 规则，代理节点挂了也能解析
#
# 三级回退：
#   ① 直连 DoH 解析出的真实 IP（-o HostName 覆盖 ssh config）
#   ② 走 ~/.ssh/config 的 ProxyCommand（推荐配置，见文档）
#   ③ 原生 git push
#
# 用法：scripts/gh-push.sh [其它 git push 参数]
# ============================================================
set -uo pipefail

SSH_KEY="${FITBRIDGE_SSH_KEY:-$HOME/.ssh/id_ed25519}"
BRANCH="${FITBRIDGE_BRANCH:-main}"
HOSTKEY_ALIAS="ssh.github.com"
RETRIES="${FITBRIDGE_PUSH_RETRIES:-3}"

resolve_ip() {
  curl -fsS --max-time 15 \
    "https://dns.alidns.com/resolve?name=${HOSTKEY_ALIAS}&type=A" 2>/dev/null \
    | grep -o '"data":"[0-9.]*"' | head -1 | cut -d'"' -f4
}

try_direct() {
  local ip="$1"; shift
  GIT_SSH_COMMAND="ssh -p 443 -o HostName=${ip} -i ${SSH_KEY} -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=accept-new -o HostKeyAlias=${HOSTKEY_ALIAS} \
    -o ConnectTimeout=20 -o ServerAliveInterval=30" \
    git push -u origin "${BRANCH}" "$@"
}

IP="$(resolve_ip)"
[[ -n "${IP}" ]] && echo "[gh-push] DoH 解析 ${HOSTKEY_ALIAS} → ${IP}"

for attempt in $(seq 1 "${RETRIES}"); do
  echo "[gh-push] 尝试 ${attempt}/${RETRIES}：直连真实 IP…"
  if [[ -n "${IP}" ]] && try_direct "${IP}"; then
    echo "[gh-push] ✓ 推送成功（直连 ${IP}）"; exit 0
  fi

  echo "[gh-push] 尝试 ${attempt}/${RETRIES}：走 ssh config 的 ProxyCommand…"
  if git push -u origin "${BRANCH}" "$@"; then
    echo "[gh-push] ✓ 推送成功（走 ssh config）"; exit 0
  fi

  echo "[gh-push] 等待 8s 后重试…" >&2
  sleep 8
done

echo "[gh-push] ✗ ${RETRIES} 轮全部失败。检查代理节点是否可用（见 docs/10-network-diagnostics.md）" >&2
exit 1
