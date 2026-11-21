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
    # ---- E01 装备系统 ----
    (
        "EQUIPMENT 定义表",
        "equipment.ts 导出 EQUIPMENT 定义表与 EQUIPMENT_IDS",
        lambda: "export const EQUIPMENT" in read("src/player/equipment.ts")
        and "export const EQUIPMENT_IDS" in read("src/player/equipment.ts"),
    ),
    (
        "ITEMS 含全部装备",
        "ITEMS 由 EQUIPMENT 生成且含材料物品表",
        lambda: "EQUIP_ITEMS" in read("src/player/survival.ts")
        and "MATERIAL_ITEMS" in read("src/player/survival.ts"),
    ),
    (
        "新增纹理注册在图集末尾",
        "装备纹理在 atlas 末尾注册（煤炭纹理为标记）",
        lambda: "装备系统（E01）" in read("src/gfx/atlas.ts")
        and "this.painters.set('coal'" in read("src/gfx/atlas.ts"),
    ),
    (
        "test:equipment 纯逻辑回归通过",
        "package.json 声明 test:equipment 且脚本文件存在",
        lambda: "test:equipment" in pkg_scripts()
        and (ROOT / "test/equipment-check.cjs").exists(),
    ),
    (
        "typecheck / build",
        "build 脚本包含 tsc --noEmit",
        lambda: "tsc --noEmit" in pkg_scripts().get("build", ""),
    ),
    # ---- E02 装备状态与战斗接入 ----
    (
        "EquipmentState 管理",
        "equipmentState.ts 定义 EquipmentState 并支持序列化",
        lambda: "class EquipmentState" in read("src/player/equipmentState.ts")
        and "serialize()" in read("src/player/equipmentState.ts"),
    ),
    (
        "护甲减伤按每点",
        "survival.ts 使用 armorReduction 并在 damage 中扣甲耐久",
        lambda: "armorReduction" in read("src/player/survival.ts")
        and "damageArmor()" in read("src/player/survival.ts"),
    ),
    (
        "武器攻击力接入 attack",
        "player.ts 读取装备攻击力并按工具类别加速挖掘",
        lambda: "weapon?.attack" in read("src/player/player.ts")
        and "miningSpeedFor" in read("src/player/player.ts"),
    ),
    (
        "test:equipment 与 test:logic",
        "两组回归覆盖装备状态与护甲减伤",
        lambda: "EquipmentState" in read("test/equipment-check.cjs")
        and "diamond_chestplate" in read("test/logic-check.cjs"),
    ),
    (
        "typecheck / lint / build 通过",
        "package.json 包含 lint / typecheck / build 三条脚本",
        lambda: all(k in pkg_scripts() for k in ("lint", "typecheck", "build")),
    ),
    # ---- E03 熔炉 / 燃料 / 烧炼 ----
    (
        "熔炉方块 id 110",
        "blocks.ts 末位追加熔炉 id 110 且 smelting.ts 有配方表",
        lambda: "id: 110" in read("src/world/blocks.ts")
        and "export const SMELTING_RECIPES" in read("src/player/smelting.ts"),
    ),
    (
        "烧炼支持燃料耗尽",
        "smelting.ts 实现自动续料与产出入包回调",
        lambda: "this.host.takeInput(material)" in read("src/player/smelting.ts")
        and "this.host.produce" in read("src/player/smelting.ts"),
    ),
    (
        "右键熔炉打开烧炼面板",
        "player/main/HUD 接入 furnace:open 与面板开关",
        lambda: "furnace:open" in read("src/player/player.ts")
        and "openFurnace" in read("src/main.ts")
        and "showFurnace" in read("src/ui/hud.ts"),
    ),
    (
        "test:smelting 纯逻辑回归通过",
        "package.json 声明 test:smelting 且脚本文件存在",
        lambda: "test:smelting" in pkg_scripts()
        and (ROOT / "test/smelting-check.cjs").exists(),
    ),
    (
        "validate --strict 通过",
        "CI 工作流使用 validate.py --strict",
        lambda: "--strict" in read(".github/workflows/verify.yml"),
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
