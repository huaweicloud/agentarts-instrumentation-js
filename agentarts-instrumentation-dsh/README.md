# agentarts-instrumentation-dsh

DSH（DeepSeek Harness）可观测插件：采集 DSH 运行时的 **trace**（会话/turn/step、LLM 调用、工具调用、子 agent 串联），经 OTLP gRPC 上报华为云 **AgentArts** 平台的 **APM**。

> 面向最终用户的完整接入流程（获取参数 → 安装 → 配置 → 重启 → 验证 → 常见问题）见
> [docs/接入指导.md](docs/接入指导.md)；其中「AI 辅助接入」章节内嵌了按操作系统区分的
> 提示词，可整段粘贴给 AI 代为完成接入。本文档偏工程实现与仓库说明。

## 仓库结构

```
├── src/                        # TypeScript 源码（运行时代码全部内联打包，依赖仅 devDependencies）
│   ├── plugin.ts               # 插件入口：服务类默认导出，订阅 session 事件 + 拦截 llm/stream
│   ├── coordinator.ts          # 事件协调器：session/turn/step/LLM/tool 生命周期 → AgentArts EventRecord
│   ├── otel-reporter.ts        # OTel 层：APM trace span 层级构建与上报
│   ├── mapping.ts              # DSH 消息结构 → AgentArts gen_ai 规范字段映射
│   ├── config.ts               # 运行配置加载（~/.dsh/plugins/<插件包名>/config.json，支持 JSONC）
│   ├── logger.ts               # 按日切分的文件日志（<outputDir>/logs/plugin-YYYY-MM-DD.log）
│   ├── probe-version.generated.ts  # 探针版本号（build.mjs 从 package.json 注入，勿手改）
│   └── test/mapping.test.ts    # 映射层单元测试（node --test）
├── configure/                  # 配置脚本（只写 config.json，不安装插件）
│   ├── dsh-agentarts-plugin.ps1   # Windows
│   └── dsh-agentarts-plugin.sh     # Linux / macOS / WSL
├── scripts/pack.mjs            # npm pack 后归一化 tgz 文件名
├── build.mjs                   # 版本注入 + esbuild 打包
├── cordis.patch.yml            # DSH bundle 补丁：插入插件行
├── locale/{en,zh}.json         # 插件管理器显示元数据（meta.title / meta.description）
├── icon.svg                    # 插件图标
├── config.example.json         # 运行配置模板（带注释的 JSONC）
└── dist/plugin.mjs             # 构建产物：单文件 ESM bundle（发布内容）
```

## 数据流

```
DSH 运行时 ── session/created|event|disposed、llm/stream ──▶ coordinator
                                                              │ 聚合为 EventRecord（gen_ai.* 规范字段）
                                                              ▼
                                                        otel-reporter
                                                              │
                                                              ▼
                                                    APM（trace，OTLP gRPC）
                                                    span：invoke_agent
                                                          └─ react step
                                                               ├─ chat <model>
                                                               └─ execute_tool <tool>
```

- **trace 结构**：每个 turn 一个 `invoke_agent` root span，其下按 step 组织 `react step`，包含 `chat <model>`（LLM 调用）与 `execute_tool <tool>`（工具调用）；`features.linkSubagentTrace` 开启时，子 agent 的 root span 以父 trace 为 parent。

- **指标能力**：token 用量、耗时、TTFT/TBT、工具与技能统计等指标实现保留在代码中，**默认关闭**，不在本文档展开。

#### 子 agent trace 串联的边界

子 agent 的 root span 以**父 turn 正在进行中的 root span** 为 parent。父 turn 结束后，它注册的父子关联即被释放，因此：

- **父 turn 进行中启动的子 agent** → 与父 trace 同链路，层级正确。
- **父 turn 结束后才启动的子 agent**（例如父委派后立即返回、子 agent 在后台继续长跑）→ **不会串联**，子 agent 形成独立 trace。

这是当前实现的有意取舍：串联只依赖父 turn 存活期间建立的关联，不做跨 turn 缓冲。

无论是否串联，子 agent 的 span 都会带 `dsh.session.parent_id` 属性，因此**仍可按父会话 ID 过滤或聚合子 span**——即使它们落在不同 trace 中。

**span 命名**：子 agent 收到 `subagent/catalog` 名称时用该名称（如 `invoke_agent researcher`）；拿不到名称时统一兜底为 `invoke_agent subagent`，不会回退成父 agent 的名字——否则父子 span 同名，在 APM 列表里无法区分。

若场景中存在"父 turn 结束后子 agent 才启动"的异步委派，分析时请以 `dsh.session.parent_id` 为准，而非仅看 trace 层级。

## 运行配置

运行时读取 `~/.dsh/plugins/agentarts-instrumentation-dsh/config.json`（支持 `//` 注释），字段说明见 [config.example.json](config.example.json)。要点：

- `enabled`：总开关（false 时不采集）。
- `otel.*`：APM 端点、认证信息与 AgentArts 控制台参数；`agentarts_agentops_otel_agent_apm_enable` 控制 trace 上报。
  `agentarts_project_id` 会作为 span 属性 `gen_ai.project.id` 上报，`agent_domain_id` 对应 `domain.id`。
- `features.captureMessageContent`：是否采集消息内容（关闭后不上报 `gen_ai.input/output.messages`、工具参数/结果文本等）。配置脚本可直接切换：`-NoMessageContent` / `--no-message-content`（关闭）、`-CaptureMessageContent $true` / `--capture-message-content true`（开启）。关闭时 `skill` 工具仍会上报**仅含技能名**的参数，用于技能维度识别。
- `features.debug`：开启后写 DEBUG 明细日志。
- `features.logRetentionDays`：按天保留 `data/logs` 日志，超期自动删除（默认 14，`0` 关闭清理）。

**启动校验**：插件加载时对 config.json 做字段校验，问题以 `[agentarts-dsh] config warning [字段]: ...` 形式输出到 DSH 主日志与文件日志：未知键给出最近键拼写建议（如 `agent_nam` → `agent_name`）、APM 开启但必填项缺失、已废弃的 `resource_version`（资源版本统一取 DSH 版本，配置里写了会被忽略）、`features` 字段类型错误等。均为告警级，不阻止运行。

**热重载**：运行期修改 config.json 后（300ms 防抖），`features.*`（debug / captureMessageContent / linkSubagentTrace / logRetentionDays）与 `agent_name` 即时生效，无需重启；`otel`、`enabled`、`outputDir`、`user.id` 的变更只提示「需重启 DSH 生效」（OTel 管线与 userId 在构造期绑定）。解析失败时保持当前配置并告警。

配置由安装脚本从命令行参数生成/合并（保留无关字段，写入前备份）；也可手工维护。

**凭据处理**：脚本写入 `config.json` 后会自动收紧文件权限（Windows 下移除继承，仅保留当前用户、SYSTEM、Administrators；Linux/macOS 下 `chmod 600`），历史备份同样处理，并只保留最近 5 份备份——备份同样含明文凭据。凭据也可以通过环境变量 `DSH_AGENTARTS_APM_TOKEN` 提供，避免出现在命令行（会被 shell 历史与进程列表记录）。

安全审查的范围、已修复问题与残余风险见 [SECURITY-NOTES.md](SECURITY-NOTES.md)。

## 隐私与数据外发（重要）

本插件会把 DSH 运行时数据发送到远端 AgentArts 平台。**请在启用前确认这些内容可以外发**。

**默认会上报的内容**：

| 类别 | 具体字段 | 说明 |
|---|---|---|
| 会话内容 | `gen_ai.input.messages`、`gen_ai.output.messages` | 用户消息与助手回复的文本 |
| 系统提示词 | `gen_ai.system_instructions` | 会话使用的 system prompt，可能含内部指令 |
| 工具调用 | `gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` | 工具参数与返回结果原文 |
| 设备标识 | `user.id` | 未配置时取主机名 |
| 会话标识 | `gen_ai.session.id` | 会话 ID |

此外还会上报 span 结构、耗时、token 用量、模型名等运行指标——这些不含内容文本。

**如果会话中可能出现敏感信息**（源码、内部文档、临时粘贴的凭据），请在
`config.json` 中关闭内容采集：

```json
{ "features": { "captureMessageContent": false } }
```

关闭后仍上报 trace 结构与性能指标，只是不含上述消息、提示词、工具参数与结果文本。
该开关支持热重载，改完即生效，无需重启。

建议同时显式设置 `user.id`（避免主机名外发）并避免在会话中粘贴真实凭据。

## 安装与配置

接入分三步：**安装插件 → 配置接入信息 → 重启 DSH**。面向最终用户的完整流程
（参数获取、desktop/web 差异、验证与排障）见 [docs/接入指导.md](docs/接入指导.md)。

### 步骤一：安装插件

插件发布在插件市场与 npm 仓库，包名 `agentarts-instrumentation-dsh`。

**desktop 形态**：在 DSH 客户端 **Plugins** → **Discover**（插件市场）安装，或在 **Add plugin** 中按包名安装。

> desktop profile 由桌面客户端独占管理，命令行 `dsh plugin --profile desktop add` 会被拒绝。

**web 形态**：

```sh
dsh plugin --profile web add agentarts-instrumentation-dsh
```

bundle 行由 [cordis.patch.yml](cordis.patch.yml) 提供；安装后重启 DSH 以加载新模块代。

### 步骤二：配置接入信息

`configure/` 目录下的脚本**随插件一起安装**，只写配置、不安装插件、不改动 profile，
直接使用包内脚本即可：

**Linux / macOS**

```bash
SCRIPT=~/.dsh/profiles/<profile>/node_modules/agentarts-instrumentation-dsh/configure/dsh-agentarts-plugin.sh
bash "$SCRIPT" --agent-id <id> --domain-id <id> --project-id <id> \
  --endpoint https://apm-access.<region>.myhuaweicloud.com \
  --agent-name "<agent-name>" --capture-message-content true
```

**Windows（PowerShell）**

```powershell
$script = "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\agentarts-instrumentation-dsh\configure\dsh-agentarts-plugin.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $script `
  -AgentId <id> -DomainId <id> -ProjectId <id> `
  -Endpoint https://apm-access.<region>.myhuaweicloud.com `
  -AgentName "<agent-name>" -CaptureMessageContent true
```

> 凭据建议通过环境变量提供（`DSH_AGENTARTS_APM_TOKEN`），避免进入命令历史。

也可以直接手工编辑 `~/.dsh/plugins/agentarts-instrumentation-dsh/config.json`
（模板见 [config.example.json](config.example.json)）。

查看当前配置摘要（不打印凭据内容）：

```bash
bash "$SCRIPT" status
```

关闭会话内容采集（敏感场景，热生效，无需重启）：

```bash
bash "$SCRIPT" --no-message-content
```

### 步骤三：重启 DSH

`otel` 段在插件加载时绑定 OTLP 管线，**不支持热更新**，配置后必须重启（desktop 完全退出客户端，
web 重启 `dsh web` 进程）。`features.*` 与 `agent_name` 支持热生效。

### 卸载

插件卸载由 DSH 自身完成：desktop 在 **Plugins** 页卸载，web 执行
`dsh plugin --profile web remove agentarts-instrumentation-dsh`。
配置文件不随卸载删除，如需清理请手动删除
`~/.dsh/plugins/agentarts-instrumentation-dsh/`。

### 为什么 `dist/plugin.mjs` 要入库

DSH 从 Git 安装时拉的是**源码，不会运行构建**（`.gitignore` 中 `dist/*` 被忽略、仅保留 `dist/plugin.mjs`）。把构建产物提交进仓库，用户安装后即可直接加载，无需：

- 授权 pnpm 在安装期执行 `prepare` 脚本（`allowBuilds`）
- 访问 npm registry 下载 typescript / esbuild

本包是零运行时依赖的单文件 bundle，因此产物入库后 Git 安装只需要一次 clone。

## 兼容性

- DSH：`engines.dsh = >=0.2.1-rc.2`（安装时校验，不设上界）。
- Node：`>= 24.9.0`。
