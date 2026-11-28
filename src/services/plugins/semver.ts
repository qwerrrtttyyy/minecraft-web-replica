/**
 * 轻量语义化版本约束（v1.5.0 插件体系 v2）。
 *
 * 只实现插件依赖真正需要的子集：精确 / 比较符 / ^ / ~ / x 通配 / 空格 AND / || OR。
 * 纯逻辑、零依赖，可被 test:snapshot 编译成 CommonJS 直接回归。
 * 不做 npm semver 的完整实现（不含构建元数据、不含 prerelease 标识符优先级）。
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

export type ComparatorOp = '=' | '>' | '>=' | '<' | '<=';

export interface Comparator {
  op: ComparatorOp;
  version: Version;
}

/** clause = AND 组合；clauses = OR 组合；空 clause 表示恒真（*） */
export type VersionRange = Comparator[][];

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;

export function parseVersion(input: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    prerelease: m[4] ?? '',
  };
}

export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // 无 prerelease 的版本高于同数字版本带 prerelease 的版本
  if (a.prerelease === '' && b.prerelease !== '') return 1;
  if (a.prerelease !== '' && b.prerelease === '') return -1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease < b.prerelease ? -1 : 1;
}

const v = (major: number, minor: number, patch: number, prerelease = ''): Version => ({
  major,
  minor,
  patch,
  prerelease,
});

const numeric = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

function expandToken(token: string): Comparator[] | null {
  const t = token.trim();
  if (t === '*' || t === 'x' || t === 'X') return [];
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(t);
  if (!m) return null;
  const op = m[1] ?? '';
  const major = numeric(m[2]);
  if (major === null) return []; // 首位就是通配符
  const minor = numeric(m[3]);
  const patch = numeric(m[4]);
  const pre = m[5] ?? '';
  const hasMinor = m[3] !== undefined && minor !== null;
  const hasPatch = m[4] !== undefined && patch !== null;
  const mi = minor ?? 0;
  const pa = patch ?? 0;

  if (op === '^') {
    if (!hasMinor)
      return [
        { op: '>=', version: v(major, 0, 0) },
        { op: '<', version: v(major + 1, 0, 0) },
      ];
    const upper = major > 0 ? v(major + 1, 0, 0) : mi > 0 ? v(0, mi + 1, 0) : v(0, 0, pa + 1);
    return [
      { op: '>=', version: v(major, mi, pa, pre) },
      { op: '<', version: upper },
    ];
  }
  if (op === '~') {
    const upper = hasMinor ? v(major, mi + 1, 0) : v(major + 1, 0, 0);
    return [
      { op: '>=', version: v(major, mi, pa, pre) },
      { op: '<', version: upper },
    ];
  }
  if (op === '' && (!hasMinor || !hasPatch)) {
    // 1 / 1.x → >=1.0.0 <2.0.0；1.2 / 1.2.x → >=1.2.0 <1.3.0
    const upper = hasMinor ? v(major, mi + 1, 0) : v(major + 1, 0, 0);
    return [
      { op: '>=', version: v(major, mi, 0) },
      { op: '<', version: upper },
    ];
  }
  const cmpOp: ComparatorOp = (op === '' ? '=' : op) as ComparatorOp;
  return [{ op: cmpOp, version: v(major, mi, pa, pre) }];
}

/** 解析范围；语法非法返回 null（与「匹配不到」区分开） */
export function parseRange(range: string): VersionRange | null {
  const r = range.trim();
  if (r === '' || r === '*' || r === 'x' || r === 'X') return [[]];
  const clauses: VersionRange = [];
  for (const part of r.split('||')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const comps: Comparator[] = [];
    for (const token of tokens) {
      const expanded = expandToken(token);
      if (expanded === null) return null;
      comps.push(...expanded);
    }
    clauses.push(comps);
  }
  return clauses;
}

export function satisfies(version: string, range: string): boolean {
  const clauses = parseRange(range);
  if (clauses === null) return false;
  const parsed = parseVersion(version);
  if (!parsed) {
    // 非 semver 版本（如 'beta'）只允许被 * 匹配，避免静默放行
    return clauses.some((clause) => clause.length === 0);
  }
  return clauses.some((clause) =>
    clause.every((c) => {
      const cmp = compareVersions(parsed, c.version);
      switch (c.op) {
        case '=':
          return cmp === 0;
        case '>':
          return cmp > 0;
        case '>=':
          return cmp >= 0;
        case '<':
          return cmp < 0;
        case '<=':
          return cmp <= 0;
        default:
          return false;
      }
    }),
  );
}

export interface DependencySpec {
  id: string;
  range: string;
}

/** `core:foo@^1.2.0` → { id, range }；无版本约束时 range 为 '*' */
export function parseDependency(spec: string): DependencySpec | null {
  const at = spec.lastIndexOf('@');
  if (at <= 0) {
    return ID_PATTERN.test(spec) ? { id: spec, range: '*' } : null;
  }
  const id = spec.slice(0, at);
  const range = spec.slice(at + 1);
  if (!ID_PATTERN.test(id) || parseRange(range) === null) return null;
  return { id, range };
}
