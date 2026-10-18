# Fixpoint

**8051 单片机的 AI 开发环境** —— 一个窗口里完成「看工程树 / 写代码 / 真编译器诊断 / 生成 hex / 问 AI」。
编译器由**你本机已安装的工具链**完成（BYOK：本仓库不附带任何厂商文件）。

> Powered by **wangcangxing**

## 下载安装包

到 [Releases](https://github.com/wangcangxing/fixpoint/releases) 下载 `Fixpoint-Setup-<版本>.exe`（NSIS 安装包，带开始菜单项与卸载程序）。
**未做代码签名** → 首次运行可能被 SmartScreen 拦一下（"更多信息 → 仍要运行"）。

## 功能

- **一个窗口**：工程树（Project / Target / Group / File / 头文件）＋ Monaco 编辑器 ＋ AI 面板 ＋ 问题列表
- **布局可调**：三栏左右拖动调宽；AI 回复区、底部问题面板可上下拖动调高（双击复位）；AI 面板可最小化成右侧竖条，点竖条恢复，尺寸与最小化状态会记住
- **真编译器闭环**：命令行编译 → 解析诊断（含链接错误）→ 点错误跳行 → hex 状态与打开所在目录
- **器件库**：直接读本机 Keil 的 `UV4.cdb`（1703 个 C51 器件 / 77 厂商），新建工程时可搜索选择，自动写入厂商、片上内存与头文件；AI 回答会带上当前器件参数和 SFR（查不到就明说，不编造）
- **AI 面板**：流式回答、**回答按 Markdown 渲染**（含语法高亮代码块）、**回复里的代码块自动并排对比当前文件**（新增绿/删除红，`+N −M`），点"应用修改"才写回（写前自动备份）
- **多模型配置**：设置 → AI 后端里可以**添加多条模型**（名称 / 后端类型 / Base URL / 模型名 / 各自的 API Key），随时切换、编辑、删除；聊天、补全和"测试连接"都按当前选中的模型走。旧的单条配置会自动显示成第一条（`default`），不用重填
- **行内补全（Ghost text）**：前缀/后缀 FIM + 多行策略 + 去重/去围栏等后处理 + 前缀缓存（按 Continue 的一手语义实现，见 `keil-completion.mjs`）
- **技能（Skills）**：外挂 Markdown 技能（工程级/用户级/内置，按优先级覆盖；**默认与其他 agent 隔离，需显式开启共享**），可按 `/技能名` 点名；在「设置 → 技能」里用**文件/文件夹选择框**安装（`.md`/`.prompt`/`.zip` 或含 `SKILL.md` 的目录），不用手输路径
- **预设提示词**：外挂 JSON 文件（用户级/工程级/自定义，**内置仅在未配置或文件损坏时兜底**），可在设置里直接编辑
- **多工程工作区（`.uvmpw`）**：新建/打开/增删成员/一键全部编译；结构按 µVision 自己的 `project_mpw.xsd` 生成
- **文件与工程命令**：新建文件（按扩展名填骨架）、打开任意文件、新建工程（生成 `.uvproj` + `main.c` + 从你本机拷 `STARTUP.A51`）、另存为、关闭文件
- **跟随外部改动**：别的编辑器/git 改了文件会自动读入；**你有未保存修改时只提示冲突、绝不覆盖**
- **Token 用量与花费**：分角色计量、有符号增量、按价格表估算
- **备份**：写文件前自动备份，备份目录可自定义（允许放在工程之外）

## 目录结构

```
keil-ide/            桌面应用（Electron 壳 + HTTP 宿主 + 前端）
  public/            页面（index.html / app.js / style.css）
  skills/            内置技能
  prompts.json       内置预设提示词（种子）
  verify/            验收脚本（可与真实工具链联动；截图不入库）
keil-*.mjs           与界面无关的引擎模块（编译/符号/补全/技能/计量/器件库/工作区…）
tools/               打包、图标、安装包构建脚本
demo/                一个可直接编译的示例工程
assets/              图标
```

## 从源码运行

1. 装好你自己的 8051 工具链（本程序通过注册表/常见路径自动发现 `UV4.exe`，也可在设置里指定）
2. `cd keil-ide && pnpm install`
3. 双击 `keil-ide/Fixpoint.cmd`（或 `pnpm start`）

开发模式：`cd keil-ide && pnpm dev` → 浏览器打开 http://127.0.0.1:4870/

## 打包与安装包

```powershell
node tools/package.mjs                     # 暂存出自包含副本 → build/app
# 1) 正规打包（带图标与 exe 元数据）
npx @electron/packager@18 build/app Fixpoint --platform=win32 --arch=x64 `
  --out=build/dist-packager --overwrite --asar --prune --app-version=0.1.0 `
  --electron-version=<你的 electron 版本> --icon=assets/fixpoint.ico
# 2) 安装包（NSIS）
npx electron-builder@25 --prepackaged build/dist-packager/Fixpoint-win32-x64 `
  --config tools/electron-builder.json --win nsis --x64
```

## 已知边界

- **只支持 Windows**（原生对话框、注册表发现编译器、资源管理器定位都依赖 Windows）
- 未做代码签名；未做自动更新
- 无烧录能力（请自行用你的 ISP 工具烧 hex）
- 器件库读自你本机 Keil（本机为 2017 年版），**不含 STC / STC15 / N76E003**；这类芯片请选兼容的 `AT89C52`
- **本仓库尚未选择开源许可证**：在补充许可证之前，默认保留所有权利，请勿直接复用代码。

## 致谢

- [Monaco Editor](https://github.com/microsoft/monaco-editor)（MIT）—— 编辑器
- [Electron](https://github.com/electron/electron)（MIT）—— 桌面壳
- 行内补全的**算法语义**参考了 [Continue](https://github.com/continuedev/continue)（Apache-2.0）的公开实现思路，本仓库为独立重写
