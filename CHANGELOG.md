# 更新日志（Changelog）

本项目所有值得注意的变更都记录在此文件。
版本号遵循「双轨版本」约定：正式版 `vN`（里程碑）/ 迭代版 `X.Y.Z`（日常迭代），
唯一来源为 `src/core/version.ts`。更详细的演进实录见 README 各版本记录章节。

## [Unreleased]

### 计划中
- 透明通道按距离排序、AABB 脱困（PR 审阅中）
- 插件体系强化：权限门禁补全、订阅归属、manifest 防篡改、级联停用（PR 审阅中）

## [1.4.2] - 2026-11-15

### 新增
- 天空光 / 方块块双通道 BFS 传播、Greedy Meshing 光照通道（`test:light` 回归）
- Web Worker 网格化池（least-busy 派发，失败整体回退主线程）
- 8 相月贴图、双层星点异相闪烁
- 44 种方块（光源 / 建材 / 植物 / 羊毛）

## [1.4.1] - 2026-11-15

### 新增
- 35 种植物 / 树种方块（id 57~91，末位追加）
- 随机刻生态引擎 `Botany` 与植物内在能量系统（solar / hydro / fungal 代谢、
  根系共享、开花采集、发光地衣供能、蘑菇趋火枯萎）
- `test:botany`（28 组）与 `test:plant-energy`（29 组）回归

## [1.4.0] - 2026-11-14

### 新增
- 10 种方块（铜 / 绿宝石 / 青金石 / 红石矿石、黏土、灰化土、仙人掌、甘蔗、蕨、花岗岩）
- `DefaultGenerator` 重构为 `columns → ores → trees → decorate` 四阶段管线 +
  群系配置表 `BIOME_PROFILES`（配置驱动自然生成）
- `test:terrain-system`（20 组断言）
- 双轨版本体系（`RELEASE=v1` / `VERSION=1.4.0`）与 `check:version` 合并护栏

### 修复
- Worker 池构造失败整体回退；存档过期回调改写状态（seq 保护）
- 编辑差分数值分桶提速（-61% ~ -77%）

## [1.3.2] - 2026-11-14

### 修复
- 运行时注册方块后 Worker 配置不刷新
- 暂停 / 死亡期间按键卡住；菜单 → 方块库关闭后直接恢复游戏
- 入水后残留摔落伤害；Worker ACK 与 busy 计数泄漏

### 新增
- 运行时诊断组（`CraftAPI.diagnostics.run()`、F3 面板、10 秒自动采样）与 `test:diagnostics`

## [1.3.1] - 2026-11-14

### 新增
- 画面润色 4 项（天穹去色带、地平线霞光、体素云立体化、水下大气）
- 光照 + 18 新方块（id 27~44）+ 图集重绘 + 视觉回归移植
- MIT LICENSE

### 修复
- 天空光遮挡后不回收；重复放置同一方块白扣背包

## [1.3.0] - 2026-11-14

### 新增
- 服务化架构（`ServiceContainer` / `EventService` / `PluginService`，CraftAPI 薄门面）
- 区块网格化迁入 Web Worker 池 + Greedy Meshing（quad 数下降约 40%）
- 天空光 / 方块光双通道光照（0~15 级，顶点进 shader）
- 性能预算与移动端优化

## [1.2.0] - 2026-11-14

### 新增
- 事件与插件独立为服务层，插件热插拔、事件错误隔离
- 浏览器实景测试纳入 `npm run verify` 与 CI

### 修复
- 流式加载竞态与多项实测缺陷

## [1.1.2] - 2026-11-13

### 变更
- 地形生成重写（域扭曲、脊线山脉、温度 × 湿度群系、渐隐洞穴、分层矿脉、跨区块树木）

## [1.1.1] - 2026-11-13

### 修复
- 模式写回等审查修复项

## [1.1.0] - 2026-11-13

### 新增
- 生存模式（生命 / 饥饿 / 挖掘耗时 / 掉落背包 / 僵尸 / 死亡重生）
- 移动端性能与交互优化（动态分辨率、触控震动、大按钮布局）

---

[Unreleased]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.4.2...HEAD
[1.4.2]: https://github.com/qwerrrtttyyy/minecraft-web-replica/releases/tag/v1.4.2
[1.4.0]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.3.2...v1.4.2
[1.3.2]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/qwerrrtttyyy/minecraft-web-replica/releases
