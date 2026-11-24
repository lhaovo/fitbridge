#!/usr/bin/env bash
# 开发用：重新构建 + 干净重启服务
#
# 踩过的坑：旧版用 `kill $(cat pid 文件)` + `pkill -f "node .../index.js"`，
#   1) 旧进程没退干净时，新进程绑不上 8080 会直接退出 → 「改了代码但跑的还是旧版」
#   2) pkill -f 的模式会误伤命令行里带同样字符串的父 shell
# 所以这里改成：按 PID 文件杀 → 按端口杀 → 用 HTTP 探测就绪。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${FITBRIDGE_PORT:-8080}"
DATA_DIR="${FITBRIDGE_DATA_DIR:-$PWD/data}"
LOG="${FITBRIDGE_LOG:-/tmp/fb.log}"
PIDFILE="${FITBRIDGE_PIDFILE:-/tmp/fb.pid}"

# 正在占用指定端口的进程 pid（空格分隔）
port_holders() {
  ss -lntp 2>/dev/null | awk -v p=":${PORT} " '$0 ~ p' \
    | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | tr '\n' ' ' || true
}

echo "→ 构建"
npx tsc -b packages/fitkit packages/core packages/adapters/otm packages/adapters/mywhoosh apps/server

echo "→ 停掉旧进程"
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
fi
# 按端口兜底清理（只杀真正占着端口的进程）
for _ in $(seq 1 30); do
  holders=$(port_holders)
  if [ -z "$holders" ]; then break; fi
  for pid in $holders; do kill "$pid" 2>/dev/null || true; done
  sleep 0.2
done
holders=$(port_holders)
if [ -n "$holders" ]; then
  echo "端口 ${PORT} 仍被占用（pid: $holders），强制结束" >&2
  for pid in $holders; do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
fi

echo "→ 启动"
# 用 setsid 脱离当前会话：否则调用方的 shell 一退出，node 也会被一起收走
FITBRIDGE_PASSWORD="${FITBRIDGE_PASSWORD:-fitbridge}" \
FITBRIDGE_PORT="${PORT}" \
FITBRIDGE_DATA_DIR="${DATA_DIR}" \
setsid nohup node apps/server/dist/index.js > "$LOG" 2>&1 < /dev/null &

# 就绪检测：用 HTTP 而不是 ss（端口刚 bind 时 ss 可能还没刷新）
ready=0
for _ in $(seq 1 80); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/" || true)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 0.25
done
if [ "$ready" != "1" ]; then
  echo "启动失败（未就绪），日志尾部：" >&2
  tail -20 "$LOG" >&2
  exit 1
fi
# setsid 之后 $! 是 setsid 的 pid，真正的 node pid 从端口反查
newpid=$(port_holders | awk '{print $1}')
echo "$newpid" > "$PIDFILE"
echo "✓ 已启动 pid=$newpid  http://127.0.0.1:${PORT}/"
