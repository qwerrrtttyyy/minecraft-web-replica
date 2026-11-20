/*
 * host_plugin_fixture.c —— 测试用 WASM host 插件（v1.6.0）。
 *
 * 它是真实编译的 wasm，演示 wasm:host 载体的全部宿主能力：
 *  - _start() 经 mc_log 打招呼，并用 mc_ext_register 订阅
 *    worldgen:column 与 gameplay:tick 两个扩展点；
 *  - mc_hook(kind,...) 在世界生成扩展点里经 mc_world_set 放方块，
 *    在 tick 扩展点里累加计数并写入插件私有存储；
 *  - 用 mc_rand() 走确定性 PRNG 路径。
 *
 * 编译后 base64 内联进 test/plugin-carrier-fixture.cjs，CI 不需要 clang。
 */
typedef unsigned char u8;
typedef int i32;
typedef double f64;

/* ---- 宿主导入（白名单 env.*）---- */
__attribute__((import_module("env"), import_name("mc_log")))
extern void mc_log(i32 ptr, i32 len);
__attribute__((import_module("env"), import_name("mc_ext_register")))
extern i32 mc_ext_register(i32 ptr, i32 len);
__attribute__((import_module("env"), import_name("mc_world_set")))
extern i32 mc_world_set(i32 x, i32 y, i32 z, i32 id);
__attribute__((import_module("env"), import_name("mc_rand")))
extern f64 mc_rand(void);
__attribute__((import_module("env"), import_name("mc_storage_set")))
extern void mc_storage_set(i32 kp, i32 kl, i32 vp, i32 vl);

static u8 scratch[4096];

/* 字符串常量位于数据段，其地址即线性内存中的合法 ptr */
static const char S_WORLDGEN[] = "worldgen:column";
static const char S_TICK[] = "gameplay:tick";
static const char S_INIT[] = "host:init";
static const char S_KEY[] = "ticks";

static i32 kind_worldgen = -1;
static i32 kind_tick = -1;
static i32 tick_count = 0;

#define LEN(a) ((i32)(sizeof(a) - 1))

__attribute__((export_name("mc_plugin_abi")))
i32 mc_plugin_abi(void) { return 1; }

__attribute__((export_name("mc_scratch_ptr")))
i32 mc_scratch_ptr(void) { return (i32)&scratch[0]; }
__attribute__((export_name("mc_scratch_size")))
i32 mc_scratch_size(void) { return 4096; }

/* 整数转 ASCII，写进 scratch 尾部；scratch 用区内下标，传出时用绝对地址 */
static i32 num_ptr, num_len;
static void itoa_scratch(i32 v) {
  char buf[16];
  i32 n = 0;
  if (v == 0) { buf[n++] = '0'; }
  else {
    char tmp[16]; i32 m = 0;
    while (v > 0) { tmp[m++] = (char)('0' + (v % 10)); v /= 10; }
    while (m > 0) buf[n++] = tmp[--m];
  }
  i32 offset = mc_scratch_size() - 64;      /* 区内下标 */
  for (i32 i = 0; i < n; i++) scratch[offset + i] = (u8)buf[i];
  num_ptr = mc_scratch_ptr() + offset;       /* 绝对地址 */
  num_len = n;
}

__attribute__((export_name("_start")))
void plugin_start(void) {
  mc_log((i32)S_INIT, LEN(S_INIT));
  kind_worldgen = mc_ext_register((i32)S_WORLDGEN, LEN(S_WORLDGEN));
  kind_tick = mc_ext_register((i32)S_TICK, LEN(S_TICK));
}

__attribute__((export_name("mc_hook")))
void mc_hook(i32 kind, f64 a, f64 b, f64 c, f64 d) {
  (void)c; (void)d;
  if (kind == kind_worldgen && kind >= 0) {
    /* 世界生成扩展点：在 (x=a, z=b) 放一个方块 id=63 */
    mc_world_set((i32)a, 40, (i32)b, 63);
  } else if (kind == kind_tick && kind >= 0) {
    tick_count++;
    itoa_scratch(tick_count);
    mc_storage_set((i32)S_KEY, LEN(S_KEY), num_ptr, num_len);
  }
  /* 走一次确定性 PRNG，验证宿主播种路径（结果仅用于防止被优化掉） */
  f64 r = mc_rand();
  if (r < 0.0) mc_log((i32)S_INIT, LEN(S_INIT));
}

__attribute__((export_name("_dispose")))
void plugin_dispose(void) { tick_count = 0; }
