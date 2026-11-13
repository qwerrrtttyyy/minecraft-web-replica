"use strict";
/** 立方体六个面的几何定义：网格生成器与方块图标/手持模型共用 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AO_LEVELS = exports.FACES = void 0;
exports.FACES = [
    {
        normal: [1, 0, 0], axis: 0, sign: 1, shade: 0.6,
        corners: [[1, 0, 1, 0, 0], [1, 0, 0, 1, 0], [1, 1, 0, 1, 1], [1, 1, 1, 0, 1]],
    },
    {
        normal: [-1, 0, 0], axis: 0, sign: -1, shade: 0.6,
        corners: [[0, 0, 0, 0, 0], [0, 0, 1, 1, 0], [0, 1, 1, 1, 1], [0, 1, 0, 0, 1]],
    },
    {
        normal: [0, 1, 0], axis: 1, sign: 1, shade: 1.0,
        corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [1, 1, 0, 1, 1], [0, 1, 0, 0, 1]],
    },
    {
        normal: [0, -1, 0], axis: 1, sign: -1, shade: 0.5,
        corners: [[0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [1, 0, 1, 1, 1], [0, 0, 1, 0, 1]],
    },
    {
        normal: [0, 0, 1], axis: 2, sign: 1, shade: 0.8,
        corners: [[0, 0, 1, 0, 0], [1, 0, 1, 1, 0], [1, 1, 1, 1, 1], [0, 1, 1, 0, 1]],
    },
    {
        normal: [0, 0, -1], axis: 2, sign: -1, shade: 0.8,
        corners: [[1, 0, 0, 0, 0], [0, 0, 0, 1, 0], [0, 1, 0, 1, 1], [1, 1, 0, 0, 1]],
    },
];
/** AO 亮度档位 */
exports.AO_LEVELS = [0.45, 0.64, 0.82, 1.0];
