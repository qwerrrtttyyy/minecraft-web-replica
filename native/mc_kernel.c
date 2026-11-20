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

#define ABI_VERSION 2
#define PERM_SIZE 512
#define SCRATCH_SIZE 4096

/* 由 wasm-ld 分配静态地址；通过 mc_perm_ptr / mc_scratch_ptr 暴露给宿主 */
static u8 perm[PERM_SIZE];
static u8 scratch[SCRATCH_SIZE];

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
