---
name: 8051-error-triage
description: 按编译器日志排查报错（C100 BOM、C202 未定义标识符、C141/C129 级联、*** ERROR Lxxx、Target not created）。当用户贴编译错误或说"编译不过"时使用。
---

# 编译器报错排查顺序

这类 8051 编译器的报错有"级联淹没"的特性：**先修最上面那一条**，不要被后面的几十条带偏。

## 先看第一行

| 首条错误 | 真实原因 | 处理 |
|---|---|---|
| `C100: unprintable character 0xEF/0xBB/0xBF` | 源文件带了 **UTF-8 BOM** | 去掉 BOM（**无 BOM** 写回）；后面跟着的 C141/C129 全是它造成的假错 |
| `C202: 'X': undefined identifier` | 标识符没定义或拼错 | 检查是否 `#include <reg51.h>`、是否把 `sbit` 写在函数里（必须写在函数外）、大小写 |
| `C141: syntax error near ...` | 通常是**上一行**少了 `;` 或括号不配 | 往上看一行，别只盯着报错行 |
| `C129: missing ';' before ...` | 同 C141 | 同上 |
| `C206: 'xxx': missing function-prototype` | 函数在调用点之后才定义/没声明 | 在文件开头加原型声明，或把定义提前 |
| `C231: 'X': redefinition` | 同一个符号定义了两次 | 检查头文件是否被重复包含（加 `#ifndef` 保护） |
| `*** ERROR Lxxx`（链接期，`L1`/`L48`/`L104`…） | 模块没参与编译、变量/函数重名、段超出容量 | 看 `Listings\<输出名>.m51` 的 `SYMBOL TABLE` 与段表；确认该 `.c` **真的加进了工程**（"未加入工程"的孤儿文件改了不生效） |
| 没有 error 但有 `Target not created.` | 链接或输出阶段失败 | 先看日志里最后一条 `*** ERROR`/`WARNING`，再看工程是否开了 `CreateHexFile` |

## 报告方式

1. 只报**首条**错误 + 文件:行号（该编译器的错误**没有列号**，别编造列号）。
2. 给出**最小修复**，不要顺手重写整个文件。
3. 修完**重新编译**确认，再报 `ERRORLEVEL`（0 无错 / 1 仅警告 / 2 有错 / 3 致命）。
