# Fixpoint v0.1 · Powered by wangcangxing

**一个窗口**里的 8051 单片机开发环境：Monaco 编辑器 + 真实编译器诊断 + hex 状态 + AI 对话 + 技能 + Token 计量。
做一个自己的窗口是因为 µVision **没有插件 SDK**、装不下 AI；而**编译/链接/日志/hex 全部交给用户本机已装的工具链**（BYOK，不带任何厂商文件）。

```
Electron 窗口 (electron-main.mjs)
        └─ 内嵌 Node 宿主 (server.mjs, HTTP/JSON)
                ├─ ../keil-core.mjs  →  用户本机 UV4.exe（发现/编译/解析）
                └─ /api/chat         →  OpenAI 兼容端点（默认）或 dsh --profile headless
```

## 启动（两种方式）

| 方式 | 命令 | 说明 |
|---|---|---|
| **桌面应用**（推荐） | 双击 `Fixpoint.cmd` | 单窗口桌面程序；启动器会先清掉 `ELECTRON_RUN_AS_NODE` |
| 开发/浏览器 | `pnpm dev` → http://127.0.0.1:4870/ | 只跑 Node 宿主，用浏览器打开 |

> ⚠️ **必须清 `ELECTRON_RUN_AS_NODE`**：本机环境里该变量常被设置（DSH 自身是 Electron 应用），Electron 会因此退化成纯 Node 并报
> `The requested module 'electron' does not provide an export named 'BrowserWindow'`。判据：`electron.exe --version` 应报 `v44.x`（不是 `v24.x`）。
>
> 未装依赖时先 `pnpm install`；Electron 二进制若没下来（pnpm 默认拦截依赖构建脚本），执行：
> `node node_modules/electron/install.js`（失败可加 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。

## AI 设置（OpenAI 兼容）

点右上角 **⚙ AI 设置**：

| 字段 | 说明 |
|---|---|
| 后端类型 | `OpenAI 兼容接口`（默认）或 `本机 DSH`（`dsh --profile headless`，一次性） |
| Base URL | 任何 OpenAI 兼容端点：DeepSeek `https://api.deepseek.com/v1`、Ollama `http://127.0.0.1:11434/v1`、LM Studio `http://127.0.0.1:1234/v1`、vLLM / one-api… |
| 模型 | 如 `deepseek-chat`；不确定就点"测试连接"，会列出端点返回的模型 |
| API Key | 存本机 `settings.json`，**接口永不回显**（只回 `apiKeySet` 与末 4 位） |
| 测试连接 | `GET {base}/models`（自动再试 `{base}/v1/models`），失败会列出尝试过的地址与原样错误 |

也可以不用界面，用环境变量覆盖：`KEIL_IDE_AI_MODE` / `KEIL_IDE_AI_BASEURL` / `KEIL_IDE_AI_MODEL` / `KEIL_IDE_AI_KEY`。

调用是 **流式**的（SSE）：`POST /api/chat` 带 `Accept: text/event-stream` 时逐字回传；不带该头则返回一份 JSON。

## 界面（一个窗口，五块）

| 区域 | 内容 |
|---|---|
| 工具栏 | 工程选择（`settings.json` 的 recent）、编译 `F7`、重编、**hex 状态**（文件名/时间/大小；未启用 `CreateHexFile` 标红）、器件与目标、工具链来源 |
| 左：文件树 | 工程声明的源文件；**未加入构建的孤儿 `.c/.A51` 标黄告警**（C51 常见坑：文件在目录里但没加进工程，改了不生效） |
| 中：编辑器 | Monaco + 自注册 `c51` 语言（`sbit`/`sfr`/`interrupt`/`data`/`idata`/`xdata`/`code` 等关键字与常用 SFR 高亮）；`Ctrl+S` 保存、`F7` 编译 |
| 右：AI 面板 | 可勾选附带**当前文件**与**最近编译错误**；回复里的 ` ```c ` 代码块会**自动并排对比**当前文件（左=当前、右=AI 建议，增绿删红，标 `+N −M`），点"应用修改"才写回（写前备份、强制无 BOM）；指向别的文件时同样先出 diff，但不切换当前标签 |
| 三栏布局 | 文件树 / 编辑器 / AI 栏之间有**左右分隔条**调宽；AI 回复区与输入区之间、编辑器与底部问题面板之间有**上下分隔条**调高（双击复位）；AI 栏可点"最小化"折成右侧竖条，点竖条恢复——尺寸与最小化状态存 localStorage，重开仍在 |
| 下：问题面板 | 来自真实编译日志的结构化诊断（文件/行/错误码/消息），点击跳行 |

## 已验证（本机实测）

- 工具链：`uv4Path=E:\qrs\software\UV4\UV4.exe source=registry c51=V9.57`（读注册表 `Products\C51`）
- 工程解析：`device=AT89C51 target=Target 1 output=C program createHex=True`，`declared=[STARTUP.A51, 2.c]`，`orphans=[]`
- 编译与 hex：`POST /api/build` → `ERRORLEVEL 0`、`code=97`，hex `C program.hex` 311 B 且 mtime 刷新
- 写文件：`bomFree=True`，备份内容等于原文，还原后 SHA256 一致，写后前 3 字节 `35 105 110`
- **OpenAI 兼容链路**（对 mock 端点）：密钥不回显（响应体无密钥、`apiKeySet=True`、`hint=****1234`）；`/api/ai/test` 列出模型；**流式 14 帧**；非流式 JSON 亦可
- **桌面应用**：`electron.exe .` 起窗口（标题 `Keil C51 AI IDE`），宿主监听 `127.0.0.1:4870`；**CDP 抓页截图确认 Monaco 正常渲染 `2.c` 并高亮 C51 关键字**
- 静态资源 `/`、`/app.js`、`/style.css`、`/vs/loader.js` 全 200

## 调试这个 UI 的办法（给以后的自己）

```
node_modules\electron\dist\electron.exe . --remote-debugging-port=9222
node verify\cdp-probe.mjs 9222      # 读控制台/异常 + 求值 DOM 表达式
node verify\cdp-shot.mjs  9222      # 页面级截图（不受窗口遮挡影响）
node verify\mock-openai.mjs 4899    # 不需要真密钥就能测 OpenAI 链路
```

## 已修掉的三个真实缺陷（都靠实测抓出来）

1. **`/api/file` 的 POST 只从 query 读 `project/path`**，而 UI 从 body 发 → 保存按钮本会 400。
2. **Monarch 分词器引用了未定义的 `@symbols`** → `setMonarchTokensProvider` 抛异常，`editor.create()` 整段不执行、编辑器空白。
3. **Monaco 的 AMD 加载是异步的**，`openFile()` 抢在 `editor.create()` 之前 → 首次打开文件是空的（现改为 `await startMonaco()`）。

另：CSP 必须给 `worker-src 'self' blob:`，否则 Monaco 的 worker 被拦、退化成主线程。

## 代码补全与工程树

**工程树**（左栏）：直接来自 `.uvproj` 的真实层级 —— `Project → Target → Source Group → 文件 → 该文件 #include 的头文件`（头文件依次在工程目录、工程 include 路径、Keil `C51\INC` 中解析，两级递归 + 环检测）。"存在于磁盘但没加入工程"的文件会单独成组并打标签：**它们不会被编译**。

**符号补全 / 悬停 / 参数签名 / F12 跳转**：符号索引 = 工程**实际 include 的头文件** + 链接映射 `Listings\<输出名>.m51` 的 `SYMBOL TABLE` + 工程源码。因此补全项右侧是**编译产物里的真实地址**（`P1` → `DATA:0090`，`LED` → `BIT:0090.0`，`delay` → `CODE:004A`）。

**行内补全（Ghost text：灰字 + `Tab` 接受）**：在 ⚙ AI 设置里勾选"行内补全"。它请求的是 **FIM（前缀 + 后缀）** 接口：

```
POST {补全端点}          # 留空 = {BaseURL}/completions
{"model":"…","prompt":"<光标之前>","suffix":"<光标之后>","max_tokens":96,"temperature":0,"stop":["\n\n"]}
```

| 端点 | 补全端点怎么填 |
|---|---|
| DeepSeek | `https://api.deepseek.com/beta/completions`（FIM 专用端点，与 `/v1` 聊天端点不同） |
| Ollama / llama.cpp / vLLM / LM Studio | 留空即可（走 `{BaseURL}/completions`），本地模型延迟通常 200–800 ms，体验最接近"边打边出" |
| 只支持 `/chat/completions` 的端点 | 不支持 FIM，请换用支持 completions 的端点 |

控制成本与卡顿的旋钮：`补全 maxTokens`（默认 96）、`补全防抖`（默认 300 ms）、**继续输入即取消上一条请求**、**前缀渐进式缓存**（多打一个字符也能复用上一次的答案，实测 `cached=true ms=0`）、以及 **`partialMs` 流式先给已有内容**（见下）。

**`partialMs`（默认 350 ms，抄 Continue 的 `showWhateverWeHaveAtXMs`）**：补全请求以 `stream:true` 发出，**到点就把模型已经吐出的内容先给出来**，而不是等完整回答。云端端点 1–3 秒的往返因此不再"打字时字跟不上"；设 0 则退回非流式（等完整回答）。**部分结果不会被缓存**，避免把截断的补全污染后续命中。

### 技能（Skills）

技能 = 一段可复用的指令包。格式与 Continue 的 `SKILL.md` / `.prompt` 一致，并采用 DSH（deepseek-harness）技能子系统的规则：

```markdown
---
name: 8051-timer                 # 必须是 kebab-case
description: 配置 8051 定时器与中断。当用户要"定时""中断"时使用。
when-to-use: 用户提到定时/中断/计时        # 可选，仅界面提示
disable-model-invocation: true   # 可选：禁止模型自动选用（用户仍可手动选）
user-invocable: false            # 可选：不出现在用户菜单里（只有模型能用）
---
# 正文
（规则/清单；也可放 <system>…</system> 段）
```

**两种形态**：目录包 `<dir>/<name>/SKILL.md`，或扁平文件 `<dir>/<name>.md` / `<name>.prompt`；**不做递归**（不扫 `**/SKILL.md`）。

**默认隔离，单独安装**：本 IDE **只用自己的技能表**——`<工程>/.keil-ide/skills`、`~/.keil-ai/skills`、随包 `bundled`；它**不会**去读别的 agent 的目录。技能通过设置里"**安装技能**"显式装入：给一个绝对路径（`.md` / `.prompt` 文件、含 `SKILL.md` 的目录，或 **`.zip`**），可装到**用户级**（所有工程可用）或**当前工程**；已装列表里可一键**卸载**（内置技能与别人目录里的技能都不可删）。安装会校验 kebab-case 名、拒绝越界路径、已存在报 409（勾"覆盖同名"可强制）。

**根目录按 rank 排序，rank 小者赢同名技能**（`source` 只是提示可见的元数据，本身不等于优先级）：

| Rank | 来源 | 目录 |
|---|---|---|
| 100 | `project-ide` | `<工程>/.keil-ide/skills` |
| 150 | `project-dsh` | `<工程>/.dsh/skills`（与 DSH 共享） |
| 200 | `project-agents` | `<工程>/.agents/skills` |
| 300 | `custom` | `settings.json` 的 `skills.dirs` 或环境变量 `KEIL_IDE_SKILL_DIRS` |
| 400 | `user-ide` | `~/.keil-ai/skills` |
| 450 | `user-dsh` | `<dshHome>/skills`（默认 `~/.dsh/skills`，**所以 DSH 的技能在这里也可见**） |
| 600 | `bundled` | `<安装目录>/skills` |

工程根取"最近的含 `.git` 的祖先目录"（与 DSH 相同），找不到就用工程目录本身。

> 表中 **150 `project-dsh`**、**200 `project-agents`**、**450 `user-dsh`** 三个"共享"来源**默认不扫描**；只有在设置里显式打开"共享其他 agent 的技能目录"才会加入（这样两个工具的技能表互不干扰）。

**调用策略**：每个技能带一对正向布尔（frontmatter 缺省为双真）。**下拉是"人用面"，只列 `userInvocable`**；模型自动选用（后续功能）走 `modelInvocable`——服务端在边界上校验，用错面会被 **403** 拒绝。

**目录只含 `name` + `description`**（不含正文与绝对路径）；**正文每次使用时重读、从不缓存**（改技能立刻生效）；文件里的 `name` 与请求不符 → **409**，未知 → **404**；`complete: false`（读取出错）时界面**保留上一次可用目录**而不是清空。注入内容形如 `<skill_content name="…">…</skill_content>` + `<skill_resources>目录</skill_resources>`。

用法：AI 面板的**技能下拉**选一个（悬浮显示描述/适用场景/来源），或在输入框用 **`/技能名 其余问题`** 点名。内置两个真实技能：`8051-timer`、`8051-error-triage`。

### 分角色模型（把补全从聊天里独立出来）

补全和聊天**可以是不同的模型 / 端点 / 密钥**（留空即跟随聊天），这样能同时拿到"聊天用大模型、补全用本地小模型"的效果：

| 字段 | 例子 |
|---|---|
| 补全模型 | `qwen2.5-coder:1.5b`（本地、快） |
| 补全 BaseURL | `http://127.0.0.1:11434/v1` |
| 补全 Key | 本地端点通常留空 |

也可用环境变量覆盖：`KEIL_IDE_INLINE_MODEL` / `KEIL_IDE_INLINE_BASEURL` / `KEIL_IDE_INLINE_KEY`。

### 多行策略与后处理

- **多行补全 `auto`（默认）**：光标后面还有代码时**只补一行**，只有在行尾才允许多行——避免把一整段塞进行中间。`always` / `never` 可强制。
- **后处理**（模型的原始回复从不直接插入）：单行模式截到行尾、去掉复读的前缀、**裁掉与光标后代码重叠的部分**（否则 `}` 会变成两个）、去掉尾部空行、纯空白结果直接丢弃。鼠标停在工具栏 `补全:` 芯片上会显示最近一次的裁剪说明。
- **上下文预算 `上下文 maxTokens`**（默认 2048，按约 4 字符/token 估算）：前 3/4 给光标之前、1/4 给光标之后。
- 这几条做法参考了 Continue 一类成熟助手的思路（它把补全作为独立的 [Autocomplete 角色](https://docs.continue.dev/customize/model-roles/autocomplete)，并在 `tabAutocompleteOptions` 里提供 `multilineCompletions` 之类的开关）。

## 设置（⚙ 设置）

工具栏的 **⚙ 设置** 打开一个分页对话框，AI 只是其中一栏：

| 页签 | 内容 |
|---|---|
| **AI 后端** | 后端类型（OpenAI 兼容 / 本机 DSH）、Base URL、**模型（真正的下拉栏：点"获取模型列表"拉 `GET /models` 填充，也可在"模型名"里手填，5 分钟缓存）**、API Key、温度 |
| **代码补全** | 行内补全开关、一次最多生成（词元）、停顿多久才请求（毫秒）、先显示部分结果的时间（毫秒）、参考上文上限（词元）、多行策略、补全端点/模型/BaseURL/Key（**分角色**：留空即跟随聊天） |
| **编辑器** | 字号、自动换行、小地图、Tab 宽度 —— 保存后**立即生效** |
| **文件** | **写入前自动备份**（开关）+ **备份文件夹**（"选择文件夹…"/"打开备份文件夹"）、**跟随外部改动**（开关）+ 检查间隔（毫秒） |
| **技能** | **默认隔离**（只扫本 IDE 自己的目录；打开"共享其他 agent 的技能目录"才会多扫三个共享目录）、自定义技能目录（每行一个）、简介字数上限、**安装技能**（`.md`／目录／`.zip`）与已装列表（可一键卸载）、"打开技能目录"/"重新扫描" |
| **诊断 / 关于** | 编译器（路径 / 是怎么找到的 / 版本 / 头文件根）、设置文件路径、"打开设置文件"、"复制诊断信息"、**用量与花费**（这次发出多少词元、上游报告的真实用量、累计、分段、按价格表估算） |

### 备份与"跟随外部改动"

- **备份**：每次保存、或用 AI 的代码覆盖之前，先把**旧内容**复制一份（文件名带时间，如 `1750000000000-main.c`）。默认放在 `<工程>/.backups`，可在"设置 → 文件"里**改成任意文件夹**（允许在工程之外），也能整个关掉。备份目录是**独立的写入白名单**：源文件写入仍然只能落在工程目录内。
- **跟随外部改动**：每隔一段时间（默认 2000 毫秒，可调）比对"当前打开的文件 / 工程声明的源文件 / hex 产物"的时间戳。发现外部改动时——**本窗口没有未保存修改**就自动重新读入并提示；**有未保存修改**就**不覆盖**你的内容，顶部芯片变红提示冲突，点它可确认后重新读取。注意：这是**轮询 mtime**，不是文件系统事件。

改动点"保存全部设置"后写回 `settings.json`（`ai` / `editor` / `skills` 三组各自一层深合并，因此留空的密钥不会被清掉）。

## 文件与工程命令（对齐 µVision 菜单）

| µVision 命令 | 这里怎么做 |
|---|---|
| Project → New µVision Project | 工具栏 **新建工程…**：选文件夹 + 工程名 + 器件 → 生成 `<名>.uvproj`、`main.c`，并从你本机安装拷一份 `STARTUP.A51`；**实测能直接编译出 hex** |
| Project → Open Project | 工具栏 **打开工程…**：原生对话框（`.uvproj` / `.uvprojx` / `.uv2`），打开后进入工程下拉的 recent 列表 |
| Project → Select Device | 新建工程里的**器件**字段是**可搜索下拉**，列表读自你本机 Keil 的 `UV4\UV4.cdb`（官方 `UVCDB2XML` 导出 **1703 个 C51 器件 / 77 厂商**）。选中即显示厂商、ROM/RAM、头文件与描述，并把 `Device/Vendor/Cpu/RegisterFile` 与片上内存写进 `.uvproj`；**`DeviceId` 库里取不到，故不写**（实测 `UV4 -b` 不需要）。库里没有的型号（STC 系列）可手填，界面会明确提示内存配置沿用默认值 |
| File → New (Ctrl+N) | 文件栏 **新建**：按扩展名填骨架（`.c` **不含 `main`**、`.h` 带 include 守卫、`.a51` 汇编骨架），随后询问是否加入工程 |
| File → Open (Ctrl+O) | 文件栏 **打开**：原生对话框；**支持工程之外的文件**——显式打开后本会话内可读可写，其余写入仍严格限制在工程目录 |
| File → Save / Save As | `Ctrl+S` 保存 / `Ctrl+Shift+S` 另存为 |
| File → Close | **关闭文件**（有未保存修改会先确认） |

> 新建工程**不附带任何厂商文件**：`.uvproj` 的 XML 由本程序生成（去掉了调试/烧录/DLL 段，`<Header>` 是我们自己的文字），`STARTUP.A51` 是**从你本机安装里拷贝**的（BYOK）。

### 器件库（只读调用本机安装，不改 `UV4.cdb`）

| 接口 | 作用 |
|---|---|
| `GET /api/devices` | 全量清单（`name/vendor/includeFile/hasMemory/iromSize/iramSize`）+ 厂商统计；`?q=` 过滤、`?vendor=` 限定厂商、`?limit=` 截断 |
| `GET /api/device?name=AT89C52&header=1` | 单个器件：完整描述 + 可直接写进 `.uvproj` 的字段 + 头文件里的 SFR/位名 |

数据来源与边界（实测，详见 `../keil-devices.mjs` 顶部注释）：

- 器件名/厂商/头文件/描述来自官方导出器（`UVCDB2XML.exe -f UV4.cdb -a C51`），**XML 本身不合法**（裸 `&`），所以按文本解析。
- `Cpu` 内存串与 `REGFILE` 来自对 `UV4.cdb` 的字段级扫描；**1703 个器件中 1693 个拿到内存配置**，其余 10 个是 "see XXX" 占位项。268 个无片上 ROM 的型号按 `IRO 0x0` 写（实测可编译），有 RAM 即可建工程（链接器的致命项是 `RAMSIZE`）。
- **`DeviceId` 没有**：导出器不提供、原始记录里也没对上；实测 `UV4 -b` 在缺省该标签时 0 error，因此不写而不是写错。
- 2017 年的库**没有 STC / STC15 / N76E003**；这类型号请用兼容的 `AT89C52`，新建工程时会提示"内存沿用默认值"。
- AI 侧：`/api/chat` 会把 `[当前器件]`（工程器件）与 `[器件库]`（用户在问题里点名的型号，最多 2 个）连同 ROM/RAM、头文件、SFR 一起注入，并在系统提示里要求"以器件库为准、查不到不要编造"。

验收脚本：`node verify/device-library.mjs`（模块）、`node verify/device-integration.mjs`（自带 host：接口 + 生成工程 + 真实编译 + 聊天注入）、`node verify/device-ui.mjs [端口]`（无头 Chrome 真实点击下拉）。

**没做**：多工程工作区（`.uvmpw`）、最近文件列表、Save All、Translate/Batch、Export/Manage、Device Database 编辑（只读调用）、License Management、Print。

## 打包成可分发的 EXE

```powershell
# 1) 暂存一个自包含副本（会把上层目录的 keil-*.mjs 摊平进来并改写 import）
node ..\tools\package.mjs            # 产物: ..\build\app

# 2) 首选：正规打包器（带图标与 exe 版本元数据；需要能访问 GitHub 下载运行时）
$ev = (Get-Content .\node_modules\electron\package.json -Raw | ConvertFrom-Json).version
npx --yes '@electron/packager@18' ..\build\app Fixpoint `
  --platform=win32 --arch=x64 --out=..\build\dist-packager --overwrite --asar --prune=true `
  --app-version=0.1.0 --electron-version=$ev --icon=..\assets\fixpoint.ico `
  --win32metadata.CompanyName=wangcangxing --win32metadata.ProductName=Fixpoint `
  --win32metadata.FileDescription='Fixpoint - 8051 单片机 AI 开发环境'

# 3) 备选（离线，GitHub 不通时）：用本机已有的运行时组装
$out = "..\build\dist\Fixpoint"
Copy-Item "$PWD\node_modules\electron\dist\*" $out -Recurse
Rename-Item "$out\electron.exe" 'Fixpoint.exe'
Copy-Item '..\build\app' "$out\resources\app" -Recurse
Remove-Item "$out\resources\default_app.asar"
```

- 打包版把设置写在**用户数据目录**（`%APPDATA%\Fixpoint\settings.json`），因为 asar 是只读的。
- 包里另附 `启动 Fixpoint.cmd`：它会先清掉 `ELECTRON_RUN_AS_NODE`（该变量为 1 时 Electron 会以纯 Node 启动，窗口和服务都不会出现）。
- **只允许跑一个实例**（`requestSingleInstanceLock`）：否则第二份会抢 4870 端口。若端口真被别的程序占了，会弹中文提示而不是 JS 异常框。
- **已知代价**：没有代码签名（换机器首次运行可能有 SmartScreen 提示）；不是单文件便携版（要单文件得 `electron-builder --portable`）。
- `..\build\` 是**可再生的中间产物**（暂存 + 打包输出，≈1 GB），交付后可以整个删掉。

## v0.1 刻意不做

安装器/代码签名/自动更新、多工程工作区、烧录（UVSOCK 不提供）、Proteus（无受支持接口）、自研 LSP（诊断直接用真编译器）、多轮会话（每次请求独立）。

## 安全与合规边界

- 只监听 `127.0.0.1`、无鉴权——**本机工具，不要暴露到局域网/公网**。
- `/api/file` 仅允许工程目录内路径；写前备份到 `.backups/`；强制无 BOM。
- 密钥只存本机 `settings.json` 且不回显；不读写 Keil 许可密钥；不携带 Arm 任何文件或头文件。
- AI 请求直接发往你配置的端点（不经第三方中转）。
