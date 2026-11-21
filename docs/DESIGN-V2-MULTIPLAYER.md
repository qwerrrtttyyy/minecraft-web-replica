# V2 设计：联机基础协作（架构与协议草案）

> 状态：设计稿（本文档是 v2.0 联机支柱的**实现前置**；代码不在本次范围）。
> 目标里程碑：**基础协作**——多名玩家在同一个存档上放/挖方块，受限但可用，无冲突解决。
> 对应路线图 `docs/ARCHITECTURE.md` v2.0 行。

## 1. 可复用的现有资产

| 资产 | 位置 | 联机用途 |
|---|---|---|
| 编辑差分模型 | `src/world/world.ts`：`edits: Map<key, BlockId>` + `editsByChunk`，`loadEdits()` 批量载入 | **天然的事件流原子单位**：一次 `setBlock` 就是一条协作事件 |
| 快照序列化 | `src/save/save.ts`：`SaveData` + `validateSave`/`normalizeSave`（三态校验、坏档隔离） | 加入房间时的**全量状态同步**直接复用现有格式 |
| 区块标脏 | `world.ts` 对角/邻区块标脏 | 远端编辑到达后只需重放编辑 + 标脏，网格化管线零改动 |
| 插件扩展点 | `src/services/plugins/extensions.ts` | 联机本身作为插件接入，不在 `main.ts` 接线 |

关键观察：本项目存档本来就是「基底地形 + 编辑差分」模型（`loadEdits` 注释明确「禁止绕过本方法直接写 edits」），这与 Minecraft 的坐标键值编辑流同构——**协作协议 = 把编辑差分从"本地重放"升级为"广播重放"**。

## 2. 架构：插件形态 + 星型拓扑

```
[host 浏览器]                                 [guest 浏览器]
  world.setBlock                                 world.setBlock
     ↓ (本地立即应用, 客户端权威预演)                ↓
  net-plugin: MultiplayerService                 MultiplayerService
     ├─ EditLog (序号化编辑流)  ←─ WebRTC DataChannel ─→  同左
     └─ 快照/编辑同步状态机                          同左
```

- **拓扑**：星型，host 权威（host 是房间存档的持有者）。第一期不做专用服务器。
- **传输**：WebRTC DataChannel（ unreliable + 有序各一条）；信令服务器仅做 SDP 交换，可后置（先用剪贴板/手工 SDP 也能开发）。
- **插件形态**：`multiplayer` 内置插件，持有 `MultiplayerService`；核心引擎只暴露两个钩子：
  1. `world:edit-applied`（通知语义，payload = 编辑 key + id）：本地或远端编辑落账后派发。
  2. `world.applyRemoteEdit(key, id)`：远端编辑入口，走与本地同一条 `edits` 写入路径（含标脏），**不**再派发为本地事件（防回环）。

## 3. 协议草案（v1，向前兼容预留）

消息统一信封：`{ v: 1, t: MsgType, seq: number, p: payload }`。

| MsgType | 方向 | payload | 说明 |
|---|---|---|---|
| `HELLO` | G→H | `{ name, pluginApi }` | 握手；pluginApi 不匹配则拒绝 |
| `WELCOME` | H→G | `{ saveData: SaveData, editSeq: number, players[] }` | 全量同步：直接复用 `SaveData`（三态校验 + 坏档隔离沿用） |
| `EDIT` | 双向 | `{ key: string, id: BlockId, seq }` | 原子编辑事件；host 为每个远端编辑回 `ACK{seq}` |
| `ACK` | H→G | `{ seq }` | host 确认落账；guest 未收到 ACK 前本地状态标「pending」 |
| `PLAYER_STATE` | 双向 | `{ pos, yaw, pitch }` | 10Hz 玩家位置（ unreliable 通道，最新覆盖） |
| `BYE` | 双向 | `{ reason }` | 优雅断开 |

- **确定性前提**：同一 `SaveData` + 同一编辑序列 → 确定性世界（项目硬规则保证：seed 驱动、双键排序）。 guests 不重算地形，只重放差分。
- **顺序**：编辑流走有序通道，按 seq 严格排序；乱序即重连（第一期不做纠错）。

## 4. 第一期明确不做（防范围失控）

- 无冲突解决：两人同时挖同一格 = 后到覆盖（host seq 定序），**不**做回滚/合并。
- 无实体/光照同步：光照由编辑重放后各端自行重算（BFS 结果确定一致）。
- 无专用服务器、无账号、无穿透保障（NAT 穿透靠 STUN，打洞失败即报错）。
- 无掉落物/生物同步—— these 属于 v2.x。

## 5. 风险与验收

| 风险 | 缓解 |
|---|---|
| `SaveData` 体积大，WELCOME 首包超时 | 分块传输 + 版本压缩；沿用「256² JSON 超预算」教训，改走二进制快照分片 |
| 远端编辑与本地随机刻（时间/昼夜等实验开关）错位 | 房间创建时同步 gamerule 快照；不一致的 guest 被降级为只读 |
| 插件回环（远端编辑再广播） | `applyRemoteEdit` 走独立路径，不触发 `world:edit-applied` 广播 |
| Worker 边界 | 编辑重放复用现有「批量载入 + 标脏」路径，Worker 协议零改动 |

**验收判据**：两客户端（同机双标签页即可）连入同一房间；A 放/挖方块，B 在 200ms 内可见且刷新后一致；断线重连后凭 `WELCOME` + 增量 `EDIT` 恢复一致；卸载 multiplayer 插件后单机行为与 `1.5.1` 零差异。
