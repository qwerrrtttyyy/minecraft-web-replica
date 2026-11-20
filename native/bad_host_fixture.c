/* 负例：import 白名单外的函数，载体必须拒绝实例化 */
__attribute__((import_module("env"), import_name("mc_evil")))
extern void mc_evil(void);

__attribute__((export_name("mc_plugin_abi")))
int abi(void) { return 1; }

__attribute__((export_name("_start")))
void start(void) { mc_evil(); }
