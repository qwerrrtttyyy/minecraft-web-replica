#!/usr/bin/env python3
"""
任务卡契约验证器。

本次修复：旧版 outputs 段只维护一个布尔变量、没有任何断言，每个任务卡必然
输出「未完成（无检查实现）」并以 0 退出，等于恒通过。现在按 outputs 文本分派到
真实检查函数，逐条输出 PASS / FAIL，FAIL 计入退出码。

用法：python3 docs/agent/validate.py [--strict]
  --strict  有 WARN（未覆盖的 output）也返回非零，供 CI 使用。
退出码 0 表示「所有可检查项通过」，不再表示「契约全部通过」。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TASKS_DIR = Path(__file__).parent / "tasks"


def read(rel):
    p = ROOT / rel
    return p.read_text(encoding="utf-8") if p.exists() else ""


def pkg_scripts():
    try:
        return json.loads(read("package.json")).get("scripts", {})
    except json.JSONDecodeError:
        return {}


# (output 关键字, 说明, 检查函数) —— 返回 (ok, 说明)
CHECKS = [
    (
        "test:visual",
        "package.json 声明 test:visual 且脚本文件存在",
        lambda: "test:visual" in pkg_scripts() and (ROOT / "test/visual-check.mjs").exists(),
    ),
    (
        "verify 工作流",
        "verify 脚本包含 test:visual 且 CI 工作流执行 npm run verify",
        lambda: "test:visual" in pkg_scripts().get("verify", "")
        and "npm run verify" in read(".github/workflows/verify.yml"),
    ),
    (
        "Xvfb",
        "CI 使用 xvfb-run + 软件渲染",
        lambda: "xvfb-run" in read(".github/workflows/verify.yml")
        and ("swiftshader" in read(".github/workflows/verify.yml")
             or "MC_GL" in read(".github/workflows/verify.yml")),
    ),
    (
        "sessionStorage",
        "视觉回归脚本固定 seed=2026 并经 sessionStorage 注入",
        lambda: "sessionStorage" in read("test/visual-check.mjs")
        and "2026" in read("test/visual-check.mjs"),
    ),
    # ---- AI 系统任务卡（A00 起）----
    (
        "ai core",
        "src/ai/Node.ts 导出 NodeStatus 与 TickContext 接口",
        lambda: "NodeStatus" in read("src/ai/Node.ts") and "TickContext" in read("src/ai/Node.ts"),
    ),
    (
        "ai composites",
        "Selector / Sequence / Parallel / RandomSelector 存在",
        lambda: all(s in read("src/ai/composites.ts")
                    for s in ("Selector", "Sequence", "Parallel", "RandomSelector")),
    ),
    (
        "ai decorators",
        "Inverter / Repeater / UntilFail / UntilSuccess 存在",
        lambda: all(s in read("src/ai/decorators.ts")
                    for s in ("Inverter", "Repeater", "UntilFail", "UntilSuccess")),
    ),
    (
        "ai conditions",
        "条件节点库九个类存在",
        lambda: all(s in read("src/ai/conditions.ts") for s in (
            "CanSeePlayer", "DistanceLt", "HealthPctLt", "IsDay", "IsInWater",
            "HasTarget", "TargetInRange", "BlackboardEq", "CanReach",
        )),
    ),
    (
        "ai actions",
        "动作节点库七个类存在",
        lambda: all(s in read("src/ai/actions.ts") for s in (
            "ChasePlayer", "FleeFrom", "AttackPlayer", "Wander", "Wait",
            "EmitEvent", "SetBlackboard",
        )),
    ),
    (
        "ai tree",
        "BehaviorTree.fromJSON 与四种生物 JSON 配置存在",
        lambda: "fromJSON" in read("src/ai/BehaviorTree.ts")
        and all((ROOT / f"src/ai/behaviors/{n}.json").exists()
                for n in ("pig", "sheep", "zombie", "skeleton")),
    ),
    (
        "ai service",
        "AIService 生命周期 API 存在",
        lambda: all(s in read("src/ai/AIService.ts") for s in (
            "registerType", "attach", "update", "enable", "disable", "reloadConfig",
        )),
    ),
    (
        "ai perception",
        "Perception 只读感知视图存在",
        lambda: "Perception" in read("src/ai/Perception.ts"),
    ),
    (
        "entity integration",
        "Entity.aiComponent 可选字段与 update 委托存在",
        lambda: "aiComponent?:" in read("src/entity/entity.ts")
        and "this.aiComponent" in read("src/entity/entity.ts"),
    ),
    (
        "test:ai",
        "package.json 声明 test:ai 且 verify 链包含它",
        lambda: "test:ai" in pkg_scripts()
        and "test:ai" in pkg_scripts().get("verify", ""),
    ),
    # ---- 植物系统深化任务卡（P00~P06）----
    (
        "plant env",
        "季节历法模块存在且一季为 6 游戏日",
        lambda: "export function seasonAt" in read("src/world/ecology.ts")
        and "DAYS_PER_SEASON = 6" in read("src/world/ecology.ts"),
    ),
    (
        "soil nutrient",
        "土壤养分模块暴露 nutrientAt / enrich",
        lambda: "export function nutrientAt" in read("src/world/soil.ts")
        and "export function enrich" in read("src/world/soil.ts"),
    ),
    (
        "plant save schema",
        "存档 schema 含可选 botany / dayCount 字段",
        lambda: "botany?:" in read("src/save/save.ts")
        and "dayCount?:" in read("src/save/save.ts"),
    ),
    (
        "plant drops",
        "确定性掉落模块存在且玩家/实体掉落路径已迁移",
        lambda: "export function rollDrops" in read("src/world/drops.ts")
        and "rollDrops" in read("src/player/player.ts")
        and "rollDrops" in read("src/entity/entity.ts"),
    ),
    (
        "compost bin",
        "堆肥桶方块 id 110~118 与图集 painter 已注册",
        lambda: "composter_ready" in read("src/world/blocks.ts")
        and "composter" in read("src/gfx/atlas.ts"),
    ),
    (
        "plant rule context",
        "植物规则上下文暴露 season / soil 且支持优先级",
        lambda: "season():" in read("src/world/plantRules.ts")
        and "priority" in read("src/world/plantRules.ts"),
    ),
    (
        "任务卡校验器",
        "validate.py 覆盖植物深化六个契约关键词",
        lambda: all(k in read("docs/agent/validate.py") for k in (
            "plant env", "soil nutrient", "plant save schema",
            "plant drops", "compost bin", "plant rule context",
        )),
    ),
    # ---- 护甲插件化（A2 / v1.5.2-alpha.1）----
    (
        "test:armor",
        "package.json 声明 test:armor 且脚本文件存在",
        lambda: "test:armor" in pkg_scripts()
        and (ROOT / "test/armor-check.cjs").exists(),
    ),
    (
        "combat:damage-incoming",
        "管道扩展点落地：extensions 常量 + survival 伤害接线",
        lambda: "COMBAT_DAMAGE_INCOMING" in read("src/services/plugins/extensions.ts")
        and "COMBAT_DAMAGE_INCOMING" in read("src/player/survival.ts"),
    ),
    (
        "core:armor",
        "armor 内置插件存在并注册进 builtinPlugins",
        lambda: "core:armor" in read("src/plugins/builtin/armor.ts")
        and "armorPlugin" in read("src/plugins/builtin/index.ts"),
    ),
    (
        "EQUIPMENT 定义表",
        "装备定义表存在且快照构建覆盖装备源文件",
        lambda: "equipmentDef" in read("src/player/equipment.ts")
        and "src/player/equipment.ts" in read("scripts/build-test-snapshot.mjs"),
    ),
    (
        "EquipmentState",
        "装备状态层存在（甲槽/耐久/序列化对称）",
        lambda: "serialize" in read("src/player/equipmentState.ts")
        and "restore" in read("src/player/equipmentState.ts"),
    ),
    (
        "DESIGN-V2-ARMOR",
        "护甲插件设计文档存在",
        lambda: (ROOT / "docs/DESIGN-V2-ARMOR.md").exists(),
    ),
    (
        "verify",
        "package.json 声明完整回归脚本族（含 test:armor）",
        lambda: all(s in pkg_scripts() for s in (
            "verify", "typecheck", "test:snapshot", "test:logic",
            "test:terrain-system", "test:services", "test:diagnostics",
            "test:botany", "test:botany-rules", "test:plant-energy",
            "test:armor", "test:visual", "test:smoke",
        )),
    ),
    # ---- E04 装备配方与怪物掉落 ----
    (
        "36 条装备配方全部可匹配",
        "crafting.ts 配置表生成 36 条装备配方，id 与 EQUIPMENT 对齐",
        lambda: "equipmentRecipes()" in read("src/player/crafting.ts")
        and "equipRecipes" in read("test/crafting-check.cjs"),
    ),
    (
        "猪羊掉皮革",
        "实体掉落表含皮革 / 铁锭 / 铁剑",
        lambda: all(s in read("src/entity/entity.ts")
                    for s in ("item:leather", "item:iron_ingot", "item:iron_sword")),
    ),
    (
        "test:crafting 覆盖装备配方",
        "合成回归覆盖装备配方的有序匹配",
        lambda: "iron_sword" in read("test/crafting-check.cjs")
        and "matchRecipe" in read("test/crafting-check.cjs"),
    ),
    # ---- E05 审查修复 ----
    (
        "燃料投入从背包扣除",
        "putFuelFrom 统一校验 / 扣背包 / 加时间，并有回归",
        lambda: "putFuelFrom" in read("src/player/smelting.ts")
        and "smelting.putFuelFrom" in read("src/main.ts")
        and "putFuelFrom" in read("test/smelting-check.cjs"),
    ),
    (
        "装备重复拾取返回 false",
        "addItem 返回布尔值且合成面板有 canProduce 拦截",
        lambda: "重复拾取返回 false" in read("src/player/survival.ts")
        and "canProduce?" in read("src/ui/crafting.ts")
        and "canProduce" in read("src/main.ts"),
    ),
    (
        "validate 全绿",
        "package.json 的 verify 链包含装备与烧炼回归",
        lambda: "test:equipment" in pkg_scripts().get("verify", "")
        and "test:smelting" in pkg_scripts().get("verify", ""),
    ),
    # ---- 内容体系完善任务卡（C00~C05）----
    # 阶段 A：谓词只检查关键词是否出现在声明它的任务卡文本中；
    # 各实现卡会逐项收紧为真实符号检查（C01 已收紧 tuning center / coal torch）。
    (
        "tuning center",
        "内容体系：tuning.ts 导出 BREED_FOODS / DROPS / POPULATION（阶段 B：真实符号）",
        lambda: all(s in read("src/core/tuning.ts") for s in (
            "export const BREED_FOODS", "export const DROPS", "export const POPULATION",
        )),
    ),
    (
        "drop system",
        "内容体系：dropLogic.ts 含 scatterOffset 且 droppedItem.ts 含 DropManager（阶段 B：真实符号）",
        lambda: "export function scatterOffset" in read("src/world/dropLogic.ts")
        and "export class DropManager" in read("src/entity/droppedItem.ts"),
    ),
    (
        "animal breeding",
        "内容体系：breeding.ts 含 isBreedFood 且 entity.ts 注册三种新被动（阶段 B：真实符号）",
        lambda: "export function isBreedFood" in read("src/entity/breeding.ts")
        and all(f"'{n}'" in read("src/entity/entity.ts") for n in ("cow", "chicken", "rabbit")),
    ),
    (
        "coal torch",
        "内容体系：blocks.ts 掉落 item:coal 且 crafting.ts 产出 torch（阶段 B：真实符号）",
        lambda: "item:coal" in read("src/world/blocks.ts")
        and "material: 'torch'" in read("src/player/crafting.ts"),
    ),
    (
        "test:drop",
        "内容体系：test/drop-check.cjs 存在且 verify 链包含 npm run test:drop",
        lambda: (ROOT / "test/drop-check.cjs").exists()
        and "npm run test:drop" in pkg_scripts().get("verify", ""),
    ),
    (
        "任务卡校验器",
        "validate.py 覆盖植物深化六个契约关键词",
        lambda: all(k in read("docs/agent/validate.py") for k in (
            "plant env", "soil nutrient", "plant save schema",
            "plant drops", "compost bin", "plant rule context",
        )),
    ),
]


def find_task_files():
    tasks = sorted(TASKS_DIR.glob("*.yaml")) + sorted(TASKS_DIR.glob("*.yml"))
    if not tasks:
        print("WARN  docs/agent/tasks/ 无任务卡")
    return tasks


def outputs_of(content):
    lines = content.splitlines()
    out, in_block = [], False
    for line in lines:
        if line.strip() == "outputs:":
            in_block = True
            continue
        if in_block:
            if line.startswith("  - "):
                out.append(line[4:].strip())
            elif line.strip() and not line.startswith(" "):
                break
    return out


def validate_task(path, strict=False):
    content = path.read_text(encoding="utf-8")
    errors, warnings = [], []

    for field in ("id", "title", "touch", "outputs"):
        if f"{field}:" not in content:
            errors.append(f"缺少字段: {field}")

    outputs = outputs_of(content)
    if not outputs:
        warnings.append("outputs 为空或未解析到列表项")

    for text in outputs:
        matched = [(kw, desc, fn) for kw, desc, fn in CHECKS if kw in text]
        if not matched:
            warnings.append(f"未覆盖的 output: {text}")
            continue
        for _kw, desc, fn in matched:
            try:
                ok = bool(fn())
            except Exception as exc:  # noqa: BLE001 - 检查器自身失败应报 FAIL
                ok, desc = False, f"{desc}（检查器异常: {exc}）"
            if ok:
                print(f"PASS  {path.name}: {desc}")
            else:
                errors.append(f"{desc} → {text}")

    if not errors and not warnings:
        print(f"INFO  {path.name}: {len(outputs)} 条 output 全部有对应检查并通过")
    for w in warnings:
        print(f"WARN  {path.name}: {w}")
    for e in errors:
        print(f"FAIL  {path.name}: {e}")
    return errors, warnings


def main():
    strict = "--strict" in sys.argv[1:]
    tasks = find_task_files()
    total_errors = total_warnings = 0
    for task in tasks:
        errors, warnings = validate_task(task, strict)
        total_errors += len(errors)
        total_warnings += len(warnings)
    print(f"\n合计：{len(tasks)} 张任务卡，FAIL {total_errors}，WARN {total_warnings}")
    if total_errors:
        return 1
    if strict and total_warnings:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
