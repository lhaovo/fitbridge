#!/usr/bin/env bash
# ============================================================
# 自愈式 GitHub push
#
# 背景：本机走 Clash fake-ip 透明代理时，github.com 会被按 SNI 匹配到
# 某个规则节点；若该节点挂掉，TCP 能连上但 TLS 握手 5s 超时，
# SSH 也会被重置（Connection closed by remote host）。
#
# 实测结论：
#   - 连真实 IP 且不带 SNI  → 直连成功（TLS 握手正常）
#   - dns.alidns.com 的 DoH → 走 DIRECT 规则，代理节点挂了也能用
# 所以这里先用 DoH 解析 ssh.github.com 的真实 IP，再用该 IP 直连 443。
#
# 用法：scripts/gh-push.sh [git push 的其它参数]
# ============================================================
set -uo pipefail

SSH_KEY="${FITBRIDGE_SSH_KEY:-$HOME/.ssh/id_ed25519}"
BRANCH="${FITBRIDGE_BRANCH:-main}"
HOSTKEY_ALIAS="ssh.github.com"

echo "[gh-push] 通过 DoH 解析 ${HOSTKEY_ALIAS} 的真实 IP…"
IP="$(curl -fsS --max-time 15 \
  "https://dns.alidns.com/resolve?name=${HOSTKEY_ALIAS}&type=A" \
  | grep -o '"data":"[0-9.]*"' | head -1 | cut -d'"' -f4)"

if [[ -z "${IP}" ]]; then
  echo "[gh-push] ✗ DoH 解析失败，回退到默认 ssh.github.com" >&2
  exec git push -u origin "${BRANCH}" "$@"
fi
echo "[gh-push] 真实 IP: ${IP}"

export GIT_SSH_COMMAND="ssh -p 443 -o HostName=${IP} -i ${SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o HostKeyAlias=${HOSTKEY_ALIAS} -o ConnectTimeout=20"

git push -u origin "${BRANCH}" "$@"
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "[gh-push] ✗ 直连 ${IP} 失败，回退到域名解析方式" >&2
  git push -u origin "${BRANCH}" "$@"
  rc=$?
fi
exit $rc
