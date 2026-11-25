# 10 · 网络故障诊断（ECONNRESET 误报为凭证失效）

> 触发事件：控制台点「重新登录」MyWhoosh 报
> `重新登录失败: 连接被重置（services.mywhoosh.com）：read ECONNRESET`
> 用户疑问：这是账号被风控了？密码错了？

**结论：都不是。是本机网关代理的上游节点挂了。** 迈金（OTM）全程正常。

---

## 1. 实测证据

### 1.1 两个平台的行为完全不对称

| 域名 | DNS 解析 | TCP | TLS 握手 | 判定 |
|---|---|---|---|---|
| `otm.onelap.cn`（迈金） | `116.62.79.121`（真实 IP） | ✅ 48ms | ✅ 144ms | **完全正常** |
| `services.mywhoosh.com` | `198.18.0.20`（fake-ip） | ✅ 13ms | ❌ 5.02s 超时 | **上游不通** |
| `github.com` | `198.18.0.23`（fake-ip） | ✅ | ❌ 5.02s 超时 | **同样不通** |
| `api.github.com` | `198.18.0.26`（fake-ip） | ✅ | ❌ 5.02s 超时 | **同样不通** |
| `www.google.com` | `198.18.0.12`（fake-ip） | ✅ | ❌ 5.02s 超时 | **同样不通** |
| `registry.npmmirror.com` | `120.226.59.135`（真实 IP） | ✅ | ✅ 95ms | 正常 |
| `dns.alidns.com`（DoH） | 真实 IP | ✅ | ✅ | 正常 |

规律非常干净：

- **解析到 `198.18.0.0/15`（Clash/Mihomo fake-ip 池）的域名 → TLS 全部在 5.00s 精确超时**
- **解析到真实 IP 的域名 → 全部正常**

`198.18.0.0/15` 是 Clash/Mihomo fake-ip 模式的保留段，代理会把所有外网域名劫持到这个假 IP，
再由 TUN/透明重定向送进代理，由代理决定规则 → 节点。

`5.00s` 这个整数是**代理自己的上游连接超时**（不是我们的超时）。同样地，
`curl http://github.com/`（明文 80 端口）也是 `5.008s` 失败 —— 说明连 HTTP 也一样，
不是 TLS 层的问题。

### 1.2 为什么 `openssl s_client` 会给出假阳性

```console
$ openssl s_client -connect services.mywhoosh.com:443 -servername services.mywhoosh.com
40B79F56CA7F0000:error:0A000126:SSL routines:ssl3_read_n:unexpected eof while reading
CONNECTED(00000003)
---
no peer certificate available          ← ★ 根本没有拿到证书
---
SSL handshake has read 0 bytes and written 330 bytes   ← ★ 服务端一个字节都没回
New, (NONE), Cipher is (NONE)
Verify return code: 0 (ok)             ← ★ 这行是假阳性，不能作为判断依据
```

`Verify return code: 0 (ok)` 在**没有收到任何证书**的情况下依然会打印。
只看这一行会得出「TLS 正常」的完全相反结论。
必须同时看 `no peer certificate available` / `SSL handshake has read 0 bytes`。

### 1.3 只有 TCP 探测同样不够

透明代理会**先自己 accept 掉 TCP 连接**，再慢慢去连上游。
所以 `TCP OK` 并不代表能通：

```
services.mywhoosh.com  TCP ✓ 13ms   TLS ✗ 5s 超时
otm.onelap.cn          TCP ✓ 48ms   TLS ✓ 104ms
```

→ **连通性自检必须做到 TLS 握手这一层**。

### 1.4 显式指定代理端口

```
$ curl -x http://192.168.78.1:7890 https://services.mywhoosh.com/
HTTP/1.1 407 Proxy Authentication Required
```

代理进程活着（能回 407），只是**所有出口节点的出站都连不上**。
`192.168.78.1` 上的 7890 / 7891 / 7892 / 9090 端口都开放，9090 是控制端口（返回 401，需 secret）。

### 1.5 连真实 IP 且不带 SNI → 成功

```console
$ openssl s_client -connect 20.6.7.17:443 -noservername
SSL handshake has read 3090 bytes and written 357 bytes
Verify return code: 0 (ok)     ← 这次是真的（有证书）
```

对比：连真实 IP **带** SNI `github.com` → 5s 超时。

说明：**到 GitHub 的真实网络路径是通的**，是 Clash 按 SNI 把 `github.com` 匹配到了一个
已失效的规则节点。这个发现后来被用来修复 `git push`（见第 4 节）。

---

## 2. 代码侧的问题（本次一并修掉）

原实现把**所有**登录失败都当成 `401 AUTH_EXPIRED`：

```
重新登录失败: 连接被重置（services.mywhoosh.com）：read ECONNRESET
```

字面上看像「账号密码过期 / 被风控」，实际上**跟账号毫无关系**。
用户会浪费时间去改密码、找平台客服，而真正的原因（本机网断了）被完全掩盖。
更糟的是：网络故障发生在登录流程里时，还可能给账号记一次风控冷却 —— 把网络问题
转嫁成了账号惩罚。

### 改动

| 文件 | 改动 |
|---|---|
| `packages/core/src/engine/risk.ts` | `AuthFailureKind` 新增 `'network'`；新增 `isNetworkFailure()`（覆盖 ECONNRESET / ETIMEDOUT / ECONNREFUSED / ENOTFOUND / EAI_AGAIN / EPIPE / EHOSTUNREACH / ENETUNREACH / socket hang up / fetch failed / 连接被重置 / 连接超时 / DNS 失败 / TLS 握手失败）；`classifyAuthFailure()` 把它放在**最前面**判定；`shouldCooldown: false`（网络故障**绝不**触发账号风控冷却）；`isTransientFailure()` 复用同一套判定 |
| `apps/server/src/app.ts` | 登录失败：网络 → **503 `UPSTREAM_UNREACHABLE`**；风控 → 429；凭证问题 → 401 `AUTH_EXPIRED` |
| `apps/server/src/app.ts` | 重新登录失败：网络 → 凭证状态标 `NETWORK`（**不再误标 `AUTH_EXPIRED`**）+ 503；文案「重新登录失败（网络不可达，凭证本身可能没问题）：…」 |
| `apps/server/src/lib/connectivity.ts`（新） | **TLS 握手级**连通性探测：DNS → TCP → TLS 三段式，5s 超时，识别 fake-ip 段 |
| `packages/core/src/ports/manifest.ts` | 新增 `apiHost?: string` |
| `packages/adapters/{otm,mywhoosh}/src/manifest.ts` | 各自声明 `apiHost` |
| `apps/server/src/app.ts` | 新增公开路由 `GET /api/v1/connectivity` |
| `apps/server/public/*` | 顶栏网络徽章 + 登录页网络提示 + 同步结果里的网络异常提示 |

### 为什么不直接用 `ping` / TCP 探活

1. 平台全部走 HTTPS，TCP 通不代表 TLS 通（透明代理假阳性，见 1.3）；
2. `ping` 会被目标丢弃且走 ICMP，很多机房直接封；
3. 只探 TLS 握手（不发业务请求）不会触发平台风控、不消耗配额。

探测请求本身是「建连 → 握手 → 断开」，**不携带任何账号信息**。

---

## 3. 用户侧怎么修

**换代理节点 / 重启 Clash**，然后：

```bash
curl http://127.0.0.1:8080/api/v1/connectivity
# 期望 allReachable: true
```

控制台顶栏的徽章会从「网络不通」变回「网络正常」，再点「重新登录」即可。
**不需要**改密码 —— 凭证本身没问题（`hasRefreshToken: true` 说明之前登录成功过）。

如果 `otm.onelap.cn` 也探测失败，那就是本机整体断网了。

---

## 4. 附带修复：代理节点挂掉时如何 git push

同一次故障里，`git push` 也挂了：

```
$ ssh -T git@github.com
kex_exchange_identification: Connection closed by remote host
Connection closed by 198.18.0.24 port 443
```

原因同源：`ssh.github.com` 被解析成 fake-ip → 走代理 → 节点不通。

利用 1.5 的发现（真实 IP + 不带 SNI 可直连），做了两件事：

1. **`~/.ssh/config`** —— 用 `ProxyCommand` 在每次连接前用 DoH 解析真实 IP 再直连：

   ```ssh
   Host github.com
     HostName ssh.github.com
     Port 443
     ProxyCommand bash -c 'IP=$(curl -fsS --max-time 15 "https://dns.alidns.com/resolve?name=ssh.github.com&type=A" | grep -o "\"data\":\"[0-9.]*\"" | head -1 | cut -d\" -f4); [ -z "$IP" ] && exit 1; exec nc -w 20 $IP 443'
   ```

   > `dns.alidns.com` 走 Clash 的 DIRECT 规则（国内域名），所以**代理节点挂了也能解析**。
   > 注意 `ProxyCommand` 里不能用 `/dev/tcp` 的写法（`&` 的优先级会让 `exec 3<>` 落空，
   > 报 `Bad file descriptor`）；`nc` 更稳。

2. **`scripts/gh-push.sh`** —— 仓库内的兜底脚本，先 DoH 解析再用 `-o HostName=<真实IP>`
   强制覆盖 ssh config 的 HostName。

   > ⚠️ 坑：ssh config 里的 `Host github.com { HostName ssh.github.com }` 会**覆盖**
   > 命令行上的其它参数来源，所以必须显式 `-o HostName=$IP`，否则 Git 仍然走 fake-ip。

实测：`ssh -T git@github.com` → `Hi lhaovo! You've successfully authenticated`，
`git push` → `Everything up-to-date`。

---

## 5. 复现与自检命令

```bash
# 一句话判定：某个域名是不是被 fake-ip 劫持了
getent hosts services.mywhoosh.com          # 198.18.x.x → 被劫持

# 三段式手测（注意必须看 read bytes，不能只看 Verify return code）
timeout 8 openssl s_client -connect services.mywhoosh.com:443 \
  -servername services.mywhoosh.com </dev/null 2>&1 \
  | grep -E "no peer certificate|handshake has read|Cipher is"

# 应用自检
curl -s http://127.0.0.1:8080/api/v1/connectivity | python3 -m json.tool
```
