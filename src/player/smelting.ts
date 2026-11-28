/**
 * 熔炉烧炼系统（纯逻辑层，不依赖 three.js 与 DOM）。
 *
 * 每台熔炉是一个「方块实体」：输入 / 燃料 / 输出三槽 + 剩余燃料与烧炼进度，
 * 由游戏主循环 tick(dt) 驱动，状态经 serialize()/restore() 随存档持久化。
 * 数值与原版对齐：每件物品烧炼 10 秒；煤 / 木炭可烧 8 件，木板 / 原木 1.5 件，木棍 0.5 件。
 */

import type { SurvivalState, Stack } from './survival';

/** 烧炼一件物品所需秒数（原版 10s） */
export const SMELT_SECONDS = 10;

/** 烧炼配方：输入材料名（方块名或物品名）→ 输出材料名（物品名或方块名，经 addDrop 解析） */
export const SMELT_RECIPES: Record<string, string> = {
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  raw_copper: 'copper_ingot',
  raw_silver: 'silver_ingot',
  raw_tin: 'tin_ingot',
  sand: 'glass',
  sandstone: 'smooth_sandstone',
  oak_log: 'charcoal',
  birch_log: 'charcoal',
  spruce_log: 'charcoal',
  acacia_log: 'charcoal',
  cherry_log: 'charcoal',
  porkchop: 'cooked_porkchop',
  beef: 'cooked_beef',
  cobblestone: 'stone',
  rabbit_meat: 'cooked_rabbit',
};

/** 燃料表：燃料可烧炼的物品件数（原版比例） */
export const FUEL_UNITS: Record<string, number> = {
  coal: 8,
  charcoal: 8,
  oak_planks: 1.5,
  spruce_planks: 1.5,
  birch_planks: 1.5,
  acacia_planks: 1.5,
  oak_log: 1.5,
  birch_log: 1.5,
  spruce_log: 1.5,
  acacia_log: 1.5,
  cherry_log: 1.5,
  crafting_table: 1.5,
  bookshelf: 1.5,
  stick: 0.5,
};

export const smeltOutputOf = (material: string): string | null => SMELT_RECIPES[material] ?? null;
export const fuelUnitsOf = (material: string): number => FUEL_UNITS[material] ?? 0;

/** 槽位材料白名单：所有合法的输入 / 输出 / 燃料材料名（存档校验用） */
export const SMELT_KNOWN_MATERIALS: ReadonlySet<string> = new Set([
  ...Object.keys(SMELT_RECIPES),
  ...Object.values(SMELT_RECIPES),
  ...Object.keys(FUEL_UNITS),
]);

export const isKnownMaterial = (material: string): boolean => SMELT_KNOWN_MATERIALS.has(material);

/** 三槽中的一格：材料名 + 数量；空槽为 null */
export interface Slot {
  material: string;
  count: number;
}

/** 单台熔炉的运行时状态（进度 / 燃烧用秒计量） */
export interface FurnaceCell {
  input: Slot | null;
  fuel: Slot | null;
  output: Slot | null;
  /** 剩余燃烧秒数 */
  burn: number;
  /** 本次点燃的总秒数（用于 UI 火焰比例） */
  burnMax: number;
  /** 当前输入的烧炼进度秒数 */
  progress: number;
}

const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** 存档形态：进度等连续值取整到 0.01s，输出材料名加 i: / b: 前缀由调用方还原 */
export interface FurnaceSave {
  pos: [number, number, number];
  input: [string, number] | null;
  fuel: [string, number] | null;
  output: [string, number] | null;
  burn: number;
  burnMax: number;
  progress: number;
}

const cloneSlot = (s: Slot | null): Slot | null => (s ? { ...s } : null);

export class Smelting {
  readonly cells = new Map<string, FurnaceCell>();

  cell(x: number, y: number, z: number): FurnaceCell {
    const key = cellKey(x, y, z);
    let c = this.cells.get(key);
    if (!c) {
      c = { input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 };
      this.cells.set(key, c);
    }
    return c;
  }

  /** 释放某坐标的熔炉状态（方块被挖掉时调用，返回其三槽内容供掉落） */
  take(x: number, y: number, z: number): (Slot | null)[] {
    const key = cellKey(x, y, z);
    const c = this.cells.get(key);
    this.cells.delete(key);
    return c ? [c.input, c.fuel, c.output] : [null, null, null];
  }

  /**
   * 统一校验 / 扣背包 / 加燃料：把背包里 count 个燃料移入燃料槽。
   * material 为燃料的材料名（木板 / 原木等方块燃料由调用方先解析出对应 Stack）。
   * 返回实际移入的数量；非燃料物品返回 0。
   */
  putFuelFrom(survival: SurvivalState, x: number, y: number, z: number, material: string, count: number, stack: Stack): number {
    const units = fuelUnitsOf(material);
    if (units <= 0 || count <= 0) return 0;
    const have = survival.countStack(stack);
    if (have <= 0) return 0;
    const n = Math.min(count, have);
    const cell = this.cell(x, y, z);
    if (cell.fuel && cell.fuel.material !== material) return 0;
    if (!survival.consume(stack, n)) return 0;
    if (cell.fuel) cell.fuel.count += n;
    else cell.fuel = { material, count: n };
    return n;
  }

  /**
   * 把 count 个材料移入输入槽（需是可烧炼材料）。
   * material 形如 'item:raw_iron'（物品）或方块名（沙子 / 原木）；
   * 方块在背包按数字 id 存，调用方须先经 materialToStack 解析出对应 Stack。
   */
  putInput(
    survival: SurvivalState, x: number, y: number, z: number,
    material: string, count: number, stack: Stack,
  ): number {
    if (smeltOutputOf(material) === null || count <= 0) return 0;
    const have = survival.countStack(stack);
    if (have <= 0) return 0;
    const n = Math.min(count, have);
    const cell = this.cell(x, y, z);
    if (cell.input && cell.input.material !== material) return 0;
    if (!survival.consume(stack, n)) return 0;
    if (cell.input) cell.input.count += n;
    else cell.input = { material, count: n };
    return n;
  }

  /** 取走输出槽全部内容进背包；返回是否取到了东西 */
  takeOutput(survival: SurvivalState, x: number, y: number, z: number): boolean {
    const cell = this.cell(x, y, z);
    if (!cell.output) return false;
    // addDrop 统一解析：item 名走 addItem，方块名（glass 等）走 addBlock
    const taken = survival.addDrop(cell.output.material, cell.output.count);
    if (taken) cell.output = null;
    return taken;
  }

  /** 推进全部熔炉：燃烧消耗、进度推进、产出结算 */
  tick(dt: number) {
    const step = Math.max(0, dt);
    for (const cell of this.cells.values()) this.tickCell(cell, step);
  }

  private tickCell(cell: FurnaceCell, dt: number) {
    const outMaterial = cell.input ? smeltOutputOf(cell.input.material) : null;
    // 输出槽已满（999 与背包堆叠上限一致）或已堆异型产物时暂停烧炼，燃料照烧
    const outputHasRoom = !cell.output || (cell.output.material === outMaterial && cell.output.count < 999);
    const canSmelt = !!outMaterial && outputHasRoom;
    if (canSmelt && cell.burn <= 0 && cell.fuel) {
      // 点燃：消耗 1 个燃料，按其可烧件数换算燃烧秒数
      const units = fuelUnitsOf(cell.fuel.material);
      cell.fuel.count -= 1;
      if (cell.fuel.count <= 0) cell.fuel = null;
      cell.burn = units * SMELT_SECONDS;
      cell.burnMax = cell.burn;
    }
    if (cell.burn > 0) {
      cell.burn = Math.max(0, cell.burn - dt);
      if (canSmelt && outMaterial) {
        cell.progress += dt;
        if (cell.progress >= SMELT_SECONDS) {
          cell.progress = 0;
          cell.input!.count -= 1;
          if (cell.input!.count <= 0) cell.input = null;
          if (cell.output) cell.output.count += 1;
          else cell.output = { material: outMaterial, count: 1 };
        }
      } else {
        // 空烧（无可烧输入）：进度归零，燃料照烧
        cell.progress = 0;
      }
    } else {
      cell.progress = 0;
    }  }

  serialize(): FurnaceSave[] {
    const round = (n: number) => Math.round(n * 100) / 100;
    const slot = (s: Slot | null): [string, number] | null => (s ? [s.material, s.count] : null);
    const out: FurnaceSave[] = [];
    for (const [key, c] of this.cells) {
      if (!c.input && !c.fuel && !c.output && c.burn <= 0) continue;
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      out.push({
        pos: [x, y, z], input: slot(c.input), fuel: slot(c.fuel), output: slot(c.output),
        burn: round(c.burn), burnMax: round(c.burnMax), progress: round(c.progress),
      });
    }
    return out;
  }

  restore(list: FurnaceSave[]) {
    for (const f of list) {
      const key = cellKey(f.pos[0], f.pos[1], f.pos[2]);
      const slotOf = (s: [string, number] | null): Slot | null => (s ? { material: s[0], count: s[1] } : null);
      this.cells.set(key, {
        input: slotOf(f.input), fuel: slotOf(f.fuel), output: slotOf(f.output),
        burn: f.burn, burnMax: f.burnMax, progress: f.progress,
      });
    }
  }
}

export const slotClone = cloneSlot;
