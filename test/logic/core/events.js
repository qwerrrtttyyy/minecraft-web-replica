"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBus = void 0;
/** 轻量类型安全事件总线（扩展点：所有 gameplay 钩子都经过这里） */
class EventBus {
    constructor() {
        this.map = new Map();
    }
    on(type, fn) {
        let set = this.map.get(type);
        if (!set) {
            set = new Set();
            this.map.set(type, set);
        }
        set.add(fn);
        return () => this.off(type, fn);
    }
    off(type, fn) {
        this.map.get(type)?.delete(fn);
    }
    emit(type, payload) {
        const set = this.map.get(type);
        if (!set)
            return;
        for (const fn of [...set])
            fn(payload);
    }
}
exports.EventBus = EventBus;
