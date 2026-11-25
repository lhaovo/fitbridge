import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { lookup } from 'node:dns/promises';

/**
 * 网络连通性自检。
 *
 * 背景：这类工具最常见的「故障」其实不是账号问题，而是本机网络/代理不通。
 * 之前用户只能看到一句 "连接被重置（services.mywhoosh.com）"，
 * 分不清是「密码错了」还是「网断了」。
 *
 * ⚠️ **必须做 TLS 握手，不能只做 TCP 连接**：
 * 透明代理（Clash/Mihomo 的 fake-ip + TUN 模式）会先自己接受 TCP 连接，
 * 再去连上游。此时 TCP 探测会「成功」，但真实请求仍然失败。
 * 实测过：services.mywhoosh.com TCP 13ms 通、TLS 5s 超时；
 * 而 otm.onelap.cn 两者都通（国内直连）。
 * 只探 TCP 会给出假阳性。
 *
 * 探测本身只做「建连 + 握手 + 断开」，不发任何业务请求 ——
 * 不会触发平台风控，也不会消耗配额。
 */

export type ProbeStage = 'dns' | 'tcp' | 'tls';

export interface HostProbe {
  host: string;
  /** 是否完整走通 TCP + TLS */
  reachable: boolean;
  /** 卡在哪一步 */
  stage: ProbeStage | 'ok';
  /** 解析到的 IP（能看出是不是被 fake-ip 劫持了） */
  ip?: string;
  /** 是否落在 fake-ip 段（198.18.0.0/15，Clash/Mihomo 的 fake-ip 池） */
  fakeIp?: boolean;
  error?: string;
  ms: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Clash/Mihomo 的 fake-ip 保留段 */
const FAKE_IP_RANGES = [
  { prefix: '198.18.', bits: 15 },
  { prefix: '198.19.', bits: 15 },
];

function isFakeIp(ip: string): boolean {
  return FAKE_IP_RANGES.some((r) => ip.startsWith(r.prefix));
}

export async function probeHost(
  host: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HostProbe> {
  const started = Date.now();
  const done = (r: Omit<HostProbe, 'host' | 'ms'>): HostProbe => ({
    host,
    ms: Date.now() - started,
    ...r,
  });

  // ── DNS ──
  let ip: string | undefined;
  try {
    const resolved = await lookup(host);
    ip = Array.isArray(resolved) ? resolved[0]?.address : resolved.address;
  } catch (err) {
    return done({
      reachable: false,
      stage: 'dns',
      error: '域名解析失败: ' + (err instanceof Error ? err.message : String(err)),
    });
  }

  // ── TCP ──
  const tcp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const socket = tcpConnect({ host, port: 443 });
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'TCP 连接超时'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish(false, err.code ?? err.message),
    );
  });

  if (!tcp.ok) {
    return done({
      reachable: false,
      stage: 'tcp',
      ip,
      fakeIp: ip ? isFakeIp(ip) : undefined,
      error: tcp.error,
    });
  }

  // ── TLS 握手 ──
  const tls = await new Promise<{ ok: boolean; error?: string; cn?: string }>(
    (resolve) => {
      let socket: TLSSocket;
      try {
        socket = tlsConnect({
          host,
          port: 443,
          servername: host,
          // 自签/私有 CA 也不影响判断「能不能连上」，所以不因证书链失败而中断
          rejectUnauthorized: false,
        });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let settled = false;
      const finish = (ok: boolean, error?: string, cn?: string) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* ignore */ }
        resolve({ ok, error, cn });
      };
      socket.setTimeout(timeoutMs);
      socket.once('secureConnect', () => {
        const cn = socket.getPeerCertificate()?.subject?.CN;
        finish(true, undefined, Array.isArray(cn) ? cn[0] : cn);
      });
      socket.once('timeout', () => finish(false, 'TLS 握手超时'));
      socket.once('error', (err: NodeJS.ErrnoException) =>
        finish(false, err.code ?? err.message),
      );
    },
  );

  if (!tls.ok) {
    return done({
      reachable: false,
      stage: 'tls',
      ip,
      fakeIp: ip ? isFakeIp(ip) : undefined,
      // TCP 通了但握手超时 = 典型症状：透明代理接了连接，但它的上游节点不通
      error:
        'TCP 已连通但 TLS 握手失败（' +
        (tls.error ?? '未知') +
        '）—— 通常是本机代理的上游节点不通',
    });
  }

  return done({
    reachable: true,
    stage: 'ok',
    ip,
    fakeIp: ip ? isFakeIp(ip) : undefined,
  });
}

/** 探测多个主机（并发） */
export async function probeHosts(
  hosts: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HostProbe[]> {
  return Promise.all(hosts.map((h) => probeHost(h, timeoutMs)));
}
