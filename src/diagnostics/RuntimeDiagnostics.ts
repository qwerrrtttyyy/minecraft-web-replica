import { VERSION } from '../core/version';
import type { GameMode } from '../core/types';

/**
 * 运行时诊断组（v1.3.2）。
 *
 * 只读取组装根收集的快照，不依赖 three.js / DOM 业务对象，因此：
 * - 浏览器内可经 `CraftAPI.diagnostics.run()` / F3 面板按需执行；
 * - Node 侧可直接用假快照做纯逻辑回归（test/diagnostics-check.cjs）；
 * - 检查项覆盖近期修复过的高风险不变量：Worker 配置、区块网格收敛、
 *   暂停态输入残留、插件生命周期、死亡状态一致性、保存脏标记。
 */

export type DiagnosticSeverity = 'error' | 'warn';

export interface DiagnosticIssue {
  id: string;
  severity: DiagnosticSeverity;
  message: string;
}

export type DiagnosticMode = 'title' | 'loading' | 'playing' | 'paused' | 'dead';

export interface DiagnosticSnapshot {
  version: string;
  mode: DiagnosticMode;
  gameMode: GameMode;
  player: { x: number; y: number; z: number; fallDistance: number } | null;
  input: { enabled: boolean; pressedKeys: string[] };
  chunks: {
    loading: boolean;
    mesherMode: 'worker' | 'main';
    workerCount: number;
    renderDistance: number;
    generated: number;
    meshed: number;
    dirty: number;
    inFlight: number;
    configReady: boolean;
    configRevision: number;
    missingMeshes: number;
    unlitChunks: number;
  };
  plugins: { id: string; state: string; dependencies?: string[] }[];
  events: { subscribers: number; channels: number; emitted: number };
  survival: { health: number; hunger: number; breath: number; dead: boolean } | null;
  entities: number;
  save: { dirty: boolean; lastOkAt: number };
  /** v1.5.0：WASM 运行时快照（可选，旧快照不含此字段时跳过相关检查） */
  wasm?: {
    status: string;
    abi: number;
    fallbackCount: number;
    selfCheckMismatches?: number;
  };
}

export interface DiagnosticReport {
  ok: boolean;
  checked: number;
  errors: number;
  warnings: number;
  durationMs: number;
  issues: DiagnosticIssue[];
}

const finite = (v: number) => Number.isFinite(v);

export function runRuntimeDiagnostics(s: DiagnosticSnapshot, now = Date.now()): DiagnosticReport {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const issues: DiagnosticIssue[] = [];
  let checked = 0;

  const check = (
    id: string, pass: boolean, message: string, severity: DiagnosticSeverity = 'error',
  ) => {
    checked++;
    if (!pass) issues.push({ id, severity, message });
  };

  check('version', s.version === VERSION,
    `版本号不一致：运行时 ${s.version}，常量 ${VERSION}`);

  // ---- 玩家 ----
  const p = s.player;
  check('player.position',
    !!p && finite(p.x) && finite(p.y) && finite(p.z) && p.y >= -1 && p.y < 512,
    p ? `玩家坐标异常：${p.x},${p.y},${p.z}` : '玩家对象缺失');
  check('player.fallDistance',
    !!p && finite(p.fallDistance) && p.fallDistance >= 0,
    p ? `摔落距离异常：${p.fallDistance}` : '玩家对象缺失');

  // ---- 输入状态机 ----
  check('input.enabled',
    s.mode !== 'playing' || s.input.enabled,
    '处于 playing 但 input.enabled=false');
  check('input.staleKeys',
    s.input.pressedKeys.length === 0 || s.input.enabled,
    `输入已禁用但仍有按键未释放：${s.input.pressedKeys.join(', ')}`);

  // ---- 区块 / Worker ----
  const c = s.chunks;
  check('chunks.config',
    c.configReady && c.configRevision >= 0,
    '网格配置未就绪（Worker 可能仍在使用旧方块元数据）');
  if (c.mesherMode === 'worker') {
    check('chunks.worker', c.workerCount >= 1 && c.workerCount <= 8,
      `Worker 池数量异常：${c.workerCount}`);
  }
  if (s.mode === 'playing' || s.mode === 'paused') {
    check('chunks.unlit', c.unlitChunks === 0,
      `有 ${c.unlitChunks} 个已生成区块未初始化光照`);
    check('chunks.ghostMesh', c.meshed <= Math.max(1, c.generated),
      `网格数 ${c.meshed} 超过已生成区块 ${c.generated}`);
    check('chunks.missingMesh',
      c.loading || c.missingMeshes === 0 || c.dirty > 0 || c.inFlight > 0,
      `${c.missingMeshes} 个视距内区块既无网格也无在途任务`);
    check('chunks.backlog', c.dirty + c.inFlight <= 24,
      `网格队列积压：dirty=${c.dirty} inFlight=${c.inFlight}`, 'warn');
  }

  // ---- 插件 / 事件 ----
  const failed = s.plugins.filter((pl) => pl.state === 'failed');
  check('plugins.failed', failed.length === 0,
    `插件初始化失败：${failed.map((pl) => pl.id).join(', ')}`);
  const byId = new Map(s.plugins.map((pl) => [pl.id, pl]));
  const dangling = s.plugins.filter(
    (pl) => pl.state === 'enabled' && (pl.dependencies ?? []).some((dep: string) => byId.get(dep)?.state !== 'enabled'),
  );
  check('plugins.dependency', dangling.length === 0,
    `启用中的插件缺少已启用的依赖：${dangling.map((pl) => `${pl.id}→${(pl.dependencies ?? []).join(',')}`).join('；')}`);
  check('events.subscribers', s.events.subscribers >= 0 && s.events.channels >= 0,
    '事件服务统计为负值');
  if (s.mode === 'playing') {
    check('events.alive', s.events.subscribers > 0,
      'playing 状态下事件总线没有任何订阅者', 'warn');
  }

  // ---- 生存 / 死亡状态 ----
  if (s.gameMode === 'survival' && s.survival) {
    const v = s.survival;
    check('survival.ranges',
      finite(v.health) && v.health >= 0 && v.health <= 20 &&
      finite(v.hunger) && v.hunger >= 0 && v.hunger <= 20 &&
      finite(v.breath) && v.breath >= 0 && v.breath <= 15,
      `生存数值越界：health=${v.health} hunger=${v.hunger} breath=${v.breath}`);
    check('survival.deadState',
      !(s.mode === 'playing' && v.dead),
      '生存状态已死亡，但主状态机仍在 playing');
    check('survival.deadOverlay',
      !(s.mode === 'dead' && !v.dead),
      '主状态机为 dead，但生存状态未标记死亡', 'warn');
  }

  // ---- WASM（v1.5.0）----
  const w = s.wasm;
  if (w) {
    check('wasm.status',
      ['disabled', 'unavailable', 'ready', 'fallback'].includes(w.status),
      `WASM 状态非法：${w.status}`);
    check('wasm.abi',
      w.status === 'disabled' || w.status === 'unavailable' || w.abi >= 1,
      `WASM 已就绪但 ABI 非法：${w.abi}`);
    check('wasm.fallback',
      w.status === 'fallback' || w.status === 'disabled' || w.fallbackCount === 0,
      `WASM 状态 ${w.status} 却记录了 ${w.fallbackCount} 次回退`);
    check('wasm.selfcheck',
      (w.selfCheckMismatches ?? 0) === 0 || w.status !== 'ready',
      `WASM 自检存在 ${w.selfCheckMismatches} 处不一致却仍处于 ready`, 'warn');
  }

  // ---- 实体 / 存档 ----
  check('entities.count', intOrZero(s.entities),
    `实体数量异常：${s.entities}`);
  check('entities.cap', s.entities <= 200,
    `实体数量偏高：${s.entities}`, 'warn');
  check('save.staleness',
    !s.save.dirty || s.save.lastOkAt <= 0 || now - s.save.lastOkAt < 30_000,
    `存档已脏超过 ${Math.round((now - s.save.lastOkAt) / 1000)} 秒`, 'warn');

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return {
    ok: issues.length === 0,
    checked,
    errors,
    warnings,
    durationMs: (typeof performance !== 'undefined' ? performance.now() : 0) - started,
    issues,
  };
}

/** 控制台分组输出：只在有问题时调用（warn 不会污染 pageerror 断言） */
export function logDiagnosticReport(report: DiagnosticReport): void {
  if (report.issues.length === 0) return;
  const title = `[diagnostics] ${report.issues.length} 项异常（error ${report.errors} / warn ${report.warnings}）`;
  if (typeof console.groupCollapsed === 'function') console.groupCollapsed(title);
  else console.warn(title);
  for (const issue of report.issues) console.warn(`[${issue.severity}] ${issue.id}: ${issue.message}`);
  if (typeof console.groupEnd === 'function') console.groupEnd();
}

/**
 * 定时运行器：组装根注入快照收集函数。
 * 自动运行只负责产生最新报告；是否输出控制台由 onReport 决定（避免刷屏）。
 */
export class DiagnosticsRunner {
  private report: DiagnosticReport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private signature = '';

  constructor(
    private readonly collect: () => DiagnosticSnapshot,
    private readonly onReport?: (report: DiagnosticReport) => void,
  ) {}

  run(): DiagnosticReport {
    const report = runRuntimeDiagnostics(this.collect());
    this.report = report;
    this.onReport?.(report);
    return report;
  }

  /** 定时运行；问题集合发生变化时才回调，持续故障不会每 10 秒刷一次日志 */
  start(intervalMs = 10_000): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      const report = this.run();
      const sig = report.issues.map((i) => `${i.id}:${i.message}`).join('|');
      if (sig !== this.signature) {
        this.signature = sig;
        if (report.issues.length > 0) logDiagnosticReport(report);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  get last(): DiagnosticReport | null {
    return this.report;
  }

  dispose(): void {
    this.stop();
  }
}

function intOrZero(v: number): boolean {
  return Number.isInteger(v) && v >= 0;
}
