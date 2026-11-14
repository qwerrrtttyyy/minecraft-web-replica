# 运作手册

## 开发流程

1. 读取 `docs/PROJECT-EXPERIENCE.md` 了解架构与硬规则
2. 查看 `docs/agent/tasks/` 待办任务卡（YAML 格式）
3. 本地 `pnpm test && pnpm typecheck` 回归验证
4. 提交前运行 `python3 docs/agent/validate.py` 校验任务卡契约
5. 提交 `port/trae-fixes`，触发 CI 验证

## 任务卡格式

```yaml
id: TASK-ID
title: 任务标题
description: 详细描述
touch:
  allow: [src/**/*.ts, test/**/*.ts]  # 允许修改的文件
  deny: []                               # 禁止修改的文件
inputs: []
outputs: []  # 必须满足的接口契约
```

## 阶段 3 光照实践经验

- `LightEngine` 用 BFS 队列管理天空光 / 方块光传播
- `Chunk.sky` / `Chunk.block` 按行存 0~15，`lit=true` 表示已初始化
- `buildMeshSnapshot` 必须连带拷贝 `sky` / `block` 到 Worker 侧
- Greedy mask key 包含光照档位：`id | ao<<8 | sky<<10 | block<<14`（`- 1` 后解码），光照不同不合并
- Shader `aLight = [sky/15, block/15]`，`lit = max(sky*daylight, block)`，基础 0.07+0.93*lit

## 常见问题排查

- **CI 浏览器启动超时**：基础设施抖动，重跑或检查 Chromium 字体/沙盒配置
- **Worker 消息未到达**：检查 `transferList` 是否包含正确的 `ArrayBuffer`
- **旧存档方块错位**：方块 ID 必须保持 append-only，id 1..n 不变