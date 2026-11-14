#!/usr/bin/env python3
"""
任务卡契约验证器
用法：python3 docs/agent/validate.py
结果：输出 FAIL/WARN/INFO，退出码 0 表示全部通过
"""
import json
import os
import sys
from pathlib import Path

TASKS_DIR = Path(__file__).parent / "tasks"

def find_task_files():
    if not TASKS_DIR.exists():
        print("WARN  docs/agent/tasks/ 目录不存在")
        return []
    tasks = list(TASKS_DIR.glob("*.yaml")) + list(TASKS_DIR.glob("*.yml"))
    if not tasks:
        print("WARN  docs/agent/tasks/ 无任务卡")
    return tasks

def validate_task(path):
    errors = []
    warnings = []
    
    # 基本 YAML 结构检查（简化版，实际项目可用 ruamel.yaml）
    content = path.read_text() if hasattr(path, 'read_text') else open(path).read()
    
    required_fields = ['id', 'title', 'touch', 'outputs']
    for field in required_fields:
        if f'{field}:' not in content:
            errors.append(f"缺少字段: {field}")
    
    # 检查 outputs 格式
    if 'outputs:' in content:
        lines = content.split('\n')
        in_outputs = False
        for line in lines:
            if line.strip().startswith('outputs:'):
                in_outputs = True
                continue
            if in_outputs and line and not line.startswith(' ') and not line.startswith('-'):
                in_outputs = False
    
    return errors, warnings

def main():
    tasks = find_task_files()
    if not tasks:
        print("INFO  当前无待办任务卡")
        return 0
    
    total_errors = 0
    total_warnings = 0
    
    for task in tasks:
        errors, warnings = validate_task(task)
        if errors:
            print(f"FAIL  {task.name}: {', '.join(errors)}")
            total_errors += 1
        if warnings:
            print(f"WARN  {task.name}: {', '.join(warnings)}")
            total_warnings += 1
        if not errors and not warnings:
            print(f"WARN  {task.name}: 未完成（无检查实现）")
            total_warnings += 1
    
    if total_errors:
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())