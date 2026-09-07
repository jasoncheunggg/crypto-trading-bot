import { config, wallets } from "./config.ts";
import { classifyEvm, TRANSFER_TOPIC } from "./classifier.ts";
import { rpcOrNull } from "./rpc.ts";
import type { Chain, Signal, Wallet } from "./types.ts";

const pad = (addr: string) => "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();

interface SubMsg {
  id?: number;
  result?: unknown;
  method?: string;
  params?: { result: { topics: string[]; transactionHash: string } };
}

/**
 * One WebSocket per chain, two subscriptions each (inbound and outbound Transfer),
 * with every tracked wallet in a single topic array. Push-based: wallet count costs nothing.
 */
export class Detector {
  private seen = new Set<string>();
  private sockets = new Map<Chain, WebSocket>();
  private backoff = new Map<Chain, number>();
  private stopped = false;

  private onSignal: (s: Signal) => void;
  private onStatus: (msg: string) => void;

  constructor(onSignal: (s: Signal) => void, onStatus: (msg: string) => void = () => {}) {
    this.onSignal = onSignal;
    this.onStatus = onStatus;
  }

  start(): void {
    for (const chain of config.chains) {
      if (config.decoders[chain] !== "evmLogs") {
        this.onStatus(`skip ${chain}: decoder "${config.decoders[chain]}" not implemented`);
        continue;
      }
      if (this.walletsOn(chain).length) this.connect(chain);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const ws of this.sockets.values()) ws.close();
  }

  private walletsOn(chain: Chain): Wallet[] {
    return wallets.filter((w) => w.family === "evm" && w.chains.includes(chain));
  }

  private connect(chain: Chain): void {
    if (this.stopped) return;
    const watched = this.walletsOn(chain);
    const topics = watched.map((w) => pad(w.address));
    const byAddr = new Map(watched.map((w) => [w.address.toLowerCase(), w]));

    const ws = new WebSocket(config.endpoints[chain]);
    this.sockets.set(chain, ws);

    ws.onopen = () => {
      this.backoff.set(chain, 0);
      // inbound: Transfer(_, _, wallet)   outbound: Transfer(_, wallet, _)
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe",
        params: ["logs", { topics: [TRANSFER_TOPIC, null, topics] }] }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe",
        params: ["logs", { topics: [TRANSFER_TOPIC, topics] }] }));
      this.onStatus(`${chain}: subscribed, ${watched.length} wallets`);
    };

    ws.onmessage = (ev) => {
      let msg: SubMsg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg.params?.result) return;
      const log = msg.params.result;
      const from = ("0x" + log.topics[1]?.slice(26)).toLowerCase();
      const to = ("0x" + log.topics[2]?.slice(26)).toLowerCase();
      const wallet = byAddr.get(to) ?? byAddr.get(from);
      if (!wallet) return;

      // One transaction can emit several matching logs; classify it once.
      const key = `${chain}:${log.transactionHash}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);

      void this.handle(wallet, chain, log.transactionHash);
    };

    ws.onclose = () => {
      if (this.stopped) return;
      const n = (this.backoff.get(chain) ?? 0) + 1;
      this.backoff.set(chain, n);
      const wait = Math.min(30_000, 1000 * 2 ** (n - 1));
      this.onStatus(`${chain}: disconnected, reconnecting in ${wait / 1000}s`);
      setTimeout(() => this.connect(chain), wait);
    };

    ws.onerror = () => { /* onclose follows and owns the retry */ };
  }

  private async handle(wallet: Wallet, chain: Chain, txHash: string): Promise<void> {
    let signal: Signal | null;
    try {
      signal = await classifyEvm(wallet, chain, txHash);
    } catch (err) {
      // "Could not classify" is not "not a buy". Say so loudly — a swallowed failure here
      // is a missed trade that looks exactly like a wallet doing nothing.
      this.onStatus(`CLASSIFY FAILED ${wallet.name} [${chain}] ${txHash} — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!signal) return;
    // Timestamp is cosmetic; the signal stands without it.
    const block = await rpcOrNull<{ timestamp: string }>(
      chain, "eth_getBlockByNumber", ["0x" + signal.blockNumber.toString(16), false],
    );
    if (block) signal.timestamp = parseInt(block.timestamp, 16);
    this.onSignal(signal);
  }
}
