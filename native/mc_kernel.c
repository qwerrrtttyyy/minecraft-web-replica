/*
 * mc_kernel.c —— Minecraft TS 的 freestanding WebAssembly 计算内核。
 *
 * 约束（与 docs/WASM.md 的 ABI 契约一致）：
 *  1. 无 libc / 无 import：只用 wasm 原生指令（f64.floor / f64.abs / f64.sqrt），
 *     因此 `WebAssembly.Module.imports` 必须为空，可在 file:// 单文件里同步实例化。
 *  2. 所有浮点表达式的运算顺序与 src/world/noiseMath.ts 逐字对应，
 *     保证 WASM 输出与 JS 参考实现逐位相等（运行时会做等价性对拍）。
 *  3. 不自行分配内存：perm 表 / scratch 的地址由导出函数返回，JS 侧写入 linear memory。
 *
 * 编译：npm run build:wasm（scripts/build-wasm.mjs 调用 clang --target=wasm32）。
 */

typedef unsigned char u8;
typedef int i32;
typedef unsigned int u32;
typedef double f64;

#define ABI_VERSION 3
#define PERM_SIZE 512
#define SCRATCH_SIZE 4096
#define BATCH_CAPACITY 1024

/* 由 wasm-ld 分配静态地址；通过 mc_perm_ptr / mc_scratch_ptr 暴露给宿主 */
static u8 perm[PERM_SIZE];
static u8 scratch[SCRATCH_SIZE];

/* 批量求值区：in 每点 3 个 f64（x,y,z，2D 函数忽略 z），out 每点 1 个 f64。
   宿主经 mc_batch_in_ptr / mc_batch_out_ptr 读写，容量由 mc_batch_capacity 给出。 */
static f64 batch_in[BATCH_CAPACITY * 3];
static f64 batch_out[BATCH_CAPACITY];

static f64 flr(f64 x) { return __builtin_floor(x); }
static f64 absf(f64 x) { return __builtin_fabs(x); }

/* 与 JS 的 ToInt32 相同的常用坐标域；超出时钳制以避免 i32.trunc_f64_s trap。
   实际世界坐标远小于 2^31，因此不影响确定性（详见 docs/WASM.md）。 */
static i32 to_i32(f64 v) {
  if (v > 2147483647.0) return 2147483647;
  if (v < -2147483648.0) return -2147483648;
  return (i32)v;
}

static f64 hash2(i32 x, i32 y) {
  return (f64)perm[(perm[x & 255] + y) & 255] / 255.0;
}

static f64 hash3(i32 x, i32 y, i32 z) {
  return (f64)perm[(perm[(perm[x & 255] + y) & 255] + z) & 255] / 255.0;
}

static f64 lerp(f64 a, f64 b, f64 t) { return a + (b - a) * t; }

/* ---- 单格哈希缓存（2D，仅批量入口内部使用）----
 *
 * 与下面的 3D 版本同理：hash2 只取决于整数格 (xi,yi)。地形列噪声按行主序批量，
 * 同一格内能连中二三十个点（行宽 24，而格宽最小 45 个世界坐标），命中就只做插值。
 * 缓存在每次批量调用开始时失效，因此 perm 被宿主重写后不会拿到旧值。
 */
typedef struct {
  i32 x, y, valid;
  f64 h[4]; /* 依次为 00/10/01/11，与 mc_noise2 取用顺序一致 */
} Cell2Memo;

static Cell2Memo cell2_memo;

static void cell2_memo_load(i32 xi, i32 yi) {
  cell2_memo.x = xi;
  cell2_memo.y = yi;
  cell2_memo.valid = 1;
  cell2_memo.h[0] = hash2(xi, yi);
  cell2_memo.h[1] = hash2(xi + 1, yi);
  cell2_memo.h[2] = hash2(xi, yi + 1);
  cell2_memo.h[3] = hash2(xi + 1, yi + 1);
}

/* 与 mc_noise2 逐位相同的带格缓存版本 */
static f64 noise2_memo(f64 x, f64 y) {
  f64 fx = flr(x), fy = flr(y);
  i32 xi = to_i32(fx), yi = to_i32(fy);
  f64 xf = x - fx, yf = y - fy;
  f64 u = xf * xf * (3.0 - 2.0 * xf);
  f64 v = yf * yf * (3.0 - 2.0 * yf);
  if (!cell2_memo.valid || cell2_memo.x != xi || cell2_memo.y != yi) cell2_memo_load(xi, yi);
  f64 a = cell2_memo.h[0];
  f64 b = cell2_memo.h[1];
  f64 c = cell2_memo.h[2];
  f64 d = cell2_memo.h[3];
  f64 val = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  return val * 2.0 - 1.0;
}

__attribute__((export_name("mc_abi")))
i32 mc_abi(void) { return ABI_VERSION; }

__attribute__((export_name("mc_perm_ptr")))
i32 mc_perm_ptr(void) { return (i32)&perm[0]; }

__attribute__((export_name("mc_scratch_ptr")))
i32 mc_scratch_ptr(void) { return (i32)&scratch[0]; }

__attribute__((export_name("mc_scratch_size")))
i32 mc_scratch_size(void) { return SCRATCH_SIZE; }

/* 与实现无关的指纹：宿主用它确认加载的是本内核编译产物，而非任意 wasm 模块。 */
__attribute__((export_name("mc_fingerprint")))
f64 mc_fingerprint(void) {
  f64 s = 0.0;
  for (i32 i = 1; i <= 16; i++) {
    f64 x = (f64)i * 0.375;
    s += flr(x) * x + __builtin_sqrt(x);
  }
  return s;
}

__attribute__((export_name("mc_noise2")))
f64 mc_noise2(f64 x, f64 y) {
  f64 fx = flr(x), fy = flr(y);
  i32 xi = to_i32(fx), yi = to_i32(fy);
  f64 xf = x - fx, yf = y - fy;
  f64 u = xf * xf * (3.0 - 2.0 * xf);
  f64 v = yf * yf * (3.0 - 2.0 * yf);
  f64 a = hash2(xi, yi);
  f64 b = hash2(xi + 1, yi);
  f64 c = hash2(xi, yi + 1);
  f64 d = hash2(xi + 1, yi + 1);
  f64 val = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  return val * 2.0 - 1.0;
}

__attribute__((export_name("mc_noise3")))
f64 mc_noise3(f64 x, f64 y, f64 z) {
  f64 fx = flr(x), fy = flr(y), fz = flr(z);
  i32 xi = to_i32(fx), yi = to_i32(fy), zi = to_i32(fz);
  f64 xf = x - fx, yf = y - fy, zf = z - fz;
  f64 u = xf * xf * (3.0 - 2.0 * xf);
  f64 v = yf * yf * (3.0 - 2.0 * yf);
  f64 w = zf * zf * (3.0 - 2.0 * zf);
  f64 c00 = lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u);
  f64 c10 = lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u);
  f64 c01 = lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u);
  f64 c11 = lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u);
  return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w) * 2.0 - 1.0;
}

/* ---- 单格哈希缓存（仅批量入口内部使用）----
 *
 * hash3 只取决于整数格坐标 (xi,yi,zi)，是纯函数；洞穴采样按列连续写入，
 * 同一列的 y 连续变化时平均每 11 个点才跨一格，因此同一格的 8 个角哈希
 * 会被重复计算十几次。这里做一层「上一次命中的格」缓存：命中就只做插值。
 *
 * 这只是消除重复计算，不改变任何算术顺序，输出与逐点 mc_noise3 逐位相同。
 * 缓存必须按批调用重置（perm 表由宿主写入，跨调用失效不可靠），
 * 所以导出的 mc_noise3 保持无状态，只有 batch 入口用它。
 */
typedef struct {
  i32 x, y, z, valid;
  f64 h[8]; /* 依次为 000/100/010/110/001/101/011/111，与 mc_noise3 取用顺序一致 */
  /* x/z 在洞穴采样里整列不变，u/w 只取决于它们：顺带缓存，省掉每点的 8 次乘加 */
  i32 uv_valid;
  f64 ux, uz, u, w;
} CellMemo;

static CellMemo cell_memo;

static void cell_memo_load(i32 xi, i32 yi, i32 zi) {
  cell_memo.x = xi;
  cell_memo.y = yi;
  cell_memo.z = zi;
  cell_memo.valid = 1;
  cell_memo.h[0] = hash3(xi, yi, zi);
  cell_memo.h[1] = hash3(xi + 1, yi, zi);
  cell_memo.h[2] = hash3(xi, yi + 1, zi);
  cell_memo.h[3] = hash3(xi + 1, yi + 1, zi);
  cell_memo.h[4] = hash3(xi, yi, zi + 1);
  cell_memo.h[5] = hash3(xi + 1, yi, zi + 1);
  cell_memo.h[6] = hash3(xi, yi + 1, zi + 1);
  cell_memo.h[7] = hash3(xi + 1, yi + 1, zi + 1);
}

/* 与 mc_noise3 逐位相同的带格缓存版本 */
static f64 noise3_memo(f64 x, f64 y, f64 z) {
  f64 fx = flr(x), fy = flr(y), fz = flr(z);
  i32 xi = to_i32(fx), yi = to_i32(fy), zi = to_i32(fz);
  f64 yf = y - fy;
  f64 v = yf * yf * (3.0 - 2.0 * yf);
  f64 u, w;
  if (cell_memo.uv_valid && cell_memo.ux == x && cell_memo.uz == z) {
    u = cell_memo.u;
    w = cell_memo.w;
  } else {
    f64 xf = x - fx, zf = z - fz;
    u = xf * xf * (3.0 - 2.0 * xf);
    w = zf * zf * (3.0 - 2.0 * zf);
    cell_memo.uv_valid = 1;
    cell_memo.ux = x;
    cell_memo.uz = z;
    cell_memo.u = u;
    cell_memo.w = w;
  }
  if (!cell_memo.valid || cell_memo.x != xi || cell_memo.y != yi || cell_memo.z != zi) {
    cell_memo_load(xi, yi, zi);
  }
  f64 c00 = lerp(cell_memo.h[0], cell_memo.h[1], u);
  f64 c10 = lerp(cell_memo.h[2], cell_memo.h[3], u);
  f64 c01 = lerp(cell_memo.h[4], cell_memo.h[5], u);
  f64 c11 = lerp(cell_memo.h[6], cell_memo.h[7], u);
  return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w) * 2.0 - 1.0;
}

__attribute__((export_name("mc_fbm2")))
f64 mc_fbm2(f64 x, f64 y, i32 octaves, f64 lacunarity, f64 gain) {
  f64 sum = 0.0, amp = 1.0, freq = 1.0, norm = 0.0;
  for (i32 i = 0; i < octaves; i++) {
    sum += mc_noise2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

__attribute__((export_name("mc_fbm3")))
f64 mc_fbm3(f64 x, f64 y, f64 z, i32 octaves, f64 lacunarity, f64 gain) {
  f64 sum = 0.0, amp = 1.0, freq = 1.0, norm = 0.0;
  for (i32 i = 0; i < octaves; i++) {
    sum += mc_noise3(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

__attribute__((export_name("mc_ridged2")))
f64 mc_ridged2(f64 x, f64 y, i32 octaves, f64 lacunarity, f64 gain) {
  f64 sum = 0.0, amp = 1.0, freq = 1.0, norm = 0.0;
  for (i32 i = 0; i < octaves; i++) {
    f64 r = 1.0 - absf(mc_noise2(x * freq, y * freq));
    sum += r * r * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/* 批量采样：一次跨界调用完成 n 个点，摊薄 JS↔WASM 边界开销。
   累加顺序与 JS 参考（for i: s += fbm2(x0 + i*step, y0)）完全一致，保证逐位相等。 */
__attribute__((export_name("mc_fbm2_batch")))
f64 mc_fbm2_batch(f64 x0, f64 y0, f64 step, i32 n, i32 octaves, f64 lacunarity, f64 gain) {
  f64 s = 0.0;
  if (n < 0 || n > 4096) return 0.0;
  for (i32 i = 0; i < n; i++) {
    s += mc_fbm2(x0 + (f64)i * step, y0, octaves, lacunarity, gain);
  }
  return s;
}

/* 整数原语：AO 四角亮度档位（供插件 / 未来网格化使用，无浮点歧义） */
__attribute__((export_name("mc_ao")))
i32 mc_ao(i32 s1, i32 s2, i32 cc) {
  return s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
}

/* 整数原语：CRC32（IEEE 802.3），宿主可用于存档 / 快照校验 */
__attribute__((export_name("mc_crc32")))
i32 mc_crc32(i32 ptr, i32 len) {
  u32 c = 0xFFFFFFFFu;
  if (len < 0 || len > SCRATCH_SIZE) return 0;
  for (i32 i = 0; i < len; i++) {
    c ^= (u32)scratch[ptr + i];
    for (i32 k = 0; k < 8; k++) {
      c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
    }
  }
  return (i32)(~c);
}

/* ---- 批量求值（ABI 3）：一次跨界处理一批点，摊薄 JS↔WASM 边界开销 ----
 *
 * 每个点独立求值、不累加，内部直接复用上面的逐点实现，因此输出与 JS 参考
 * 逐位一致。返回值是实际处理点数（n 钳制到 [0, BATCH_CAPACITY]）。
 */

__attribute__((export_name("mc_batch_in_ptr")))
i32 mc_batch_in_ptr(void) { return (i32)&batch_in[0]; }

__attribute__((export_name("mc_batch_out_ptr")))
i32 mc_batch_out_ptr(void) { return (i32)&batch_out[0]; }

__attribute__((export_name("mc_batch_capacity")))
i32 mc_batch_capacity(void) { return BATCH_CAPACITY; }

static i32 clamp_batch(i32 n) {
  if (n < 0) return 0;
  if (n > BATCH_CAPACITY) return BATCH_CAPACITY;
  return n;
}

__attribute__((export_name("mc_batch_noise2")))
i32 mc_batch_noise2(i32 n) {
  i32 m = clamp_batch(n);
  cell2_memo.valid = 0;
  for (i32 i = 0; i < m; i++) {
    batch_out[i] = noise2_memo(batch_in[i * 3], batch_in[i * 3 + 1]);
  }
  return m;
}

__attribute__((export_name("mc_batch_noise3")))
i32 mc_batch_noise3(i32 n) {
  i32 m = clamp_batch(n);
  cell_memo.valid = 0;
  cell_memo.uv_valid = 0;
  for (i32 i = 0; i < m; i++) {
    batch_out[i] = noise3_memo(batch_in[i * 3], batch_in[i * 3 + 1], batch_in[i * 3 + 2]);
  }
  return m;
}

/* 倍频循环放外层、点循环放内层：每个点的累加顺序（逐倍频从 0.0 起加）与原实现
   完全相同，所以输出逐位不变；换来的是同一倍频内连续点共享格缓存。 */
__attribute__((export_name("mc_batch_fbm2")))
i32 mc_batch_fbm2(i32 n, i32 octaves, f64 lacunarity, f64 gain) {
  i32 m = clamp_batch(n);
  f64 amp = 1.0, freq = 1.0, norm = 0.0;
  for (i32 o = 0; o < octaves; o++) {
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  for (i32 i = 0; i < m; i++) batch_out[i] = 0.0;
  cell2_memo.valid = 0;
  amp = 1.0;
  freq = 1.0;
  for (i32 o = 0; o < octaves; o++) {
    for (i32 i = 0; i < m; i++) {
      batch_out[i] += noise2_memo(batch_in[i * 3] * freq, batch_in[i * 3 + 1] * freq) * amp;
    }
    amp *= gain;
    freq *= lacunarity;
  }
  for (i32 i = 0; i < m; i++) batch_out[i] = batch_out[i] / norm;
  return m;
}

__attribute__((export_name("mc_batch_fbm3")))
i32 mc_batch_fbm3(i32 n, i32 octaves, f64 lacunarity, f64 gain) {
  i32 m = clamp_batch(n);
  for (i32 i = 0; i < m; i++) {
    batch_out[i] = mc_fbm3(batch_in[i * 3], batch_in[i * 3 + 1], batch_in[i * 3 + 2], octaves, lacunarity, gain);
  }
  return m;
}

__attribute__((export_name("mc_batch_ridged2")))
i32 mc_batch_ridged2(i32 n, i32 octaves, f64 lacunarity, f64 gain) {
  i32 m = clamp_batch(n);
  f64 amp = 1.0, freq = 1.0, norm = 0.0;
  for (i32 o = 0; o < octaves; o++) {
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  for (i32 i = 0; i < m; i++) batch_out[i] = 0.0;
  cell2_memo.valid = 0;
  amp = 1.0;
  freq = 1.0;
  for (i32 o = 0; o < octaves; o++) {
    for (i32 i = 0; i < m; i++) {
      f64 r = 1.0 - absf(noise2_memo(batch_in[i * 3] * freq, batch_in[i * 3 + 1] * freq));
      batch_out[i] += r * r * amp;
    }
    amp *= gain;
    freq *= lacunarity;
  }
  for (i32 i = 0; i < m; i++) batch_out[i] = batch_out[i] / norm;
  return m;
}
