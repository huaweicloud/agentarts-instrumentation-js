# huaweicloud-agentarts-observation-dsh-plugin

DSH（DeepSeek Harness）可观测插件：采集 DSH 运行时的 **trace**（会话/turn/step、LLM 调用、工具调用、子 agent 串联）与 **metric**（token 用量、耗时、TTFT/TBT、工具/技能统计），经 OTLP gRPC 上报华为云 **AgentArts** 平台——trace 到 **APM**，metric 到 **AOM**。

> 面向最终用户的完整接入流程（获取参数 → 安装 → 配置 → 重启 → 验证 → 常见问题）见
> [docs/接入指导.md](docs/接入指导.md)；希望让 AI 代为完成接入的，把
> [docs/AI接入Prompt.md](docs/AI接入Prompt.md) 的指令正文整段粘贴给它即可。
> 本文档偏工程实现与仓库说明。

## 仓库结构

```
├── src/                        # TypeScript 源码（运行时代码全部内联打包，依赖仅 devDependencies）
│   ├── plugin.ts               # 插件入口：服务类默认导出，订阅 session 事件 + 拦截 llm/stream
│   ├── coordinator.ts          # 事件协调器：session/turn/step/LLM/tool 生命周期 → AgentArts EventRecord
│   ├── otel-reporter.ts        # OTel 层：APM trace span 层级 + AOM metric 注册与上报
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
                                              ┌───────────────┴───────────────┐
                                              ▼                               ▼
                                    APM（trace，OTLP gRPC）        AOM（metric，OTLP gRPC）
                                    span：invoke_agent             counter / histogram / gauge
                                          └─ react step                  （60s 周期导出）
                                               ├─ chat <model>
                                               └─ execute_tool <tool>
```

- **trace 结构**：每个 turn 一个 `invoke_agent` root span，其下按 step 组织 `react step`，包含 `chat <model>`（LLM 调用）与 `execute_tool <tool>`（工具调用）；`features.linkSubagentTrace` 开启时，子 agent 的 root span 以父 trace 为 parent。

- **metric 清单**：token（input/output/cache）、请求数、LLM 耗时、TTFT/TBT、agent 耗时、工具调用数/耗时、技能调用数/耗时/失败数、会话/用量状态 gauge；点号命名指标同时注册下划线别名（对齐 AOM 的 `_seconds` 后缀转换规则）。

#### 子 agent trace 串联的边界

子 agent 的 root span 以**父 turn 正在进行中的 root span** 为 parent。父 turn 结束后，它注册的父子关联即被释放，因此：

- **父 turn 进行中启动的子 agent** → 与父 trace 同链路，层级正确。
- **父 turn 结束后才启动的子 agent**（例如父委派后立即返回、子 agent 在后台继续长跑）→ **不会串联**，子 agent 形成独立 trace。

这是当前实现的有意取舍：串联只依赖父 turn 存活期间建立的关联，不做跨 turn 缓冲。

无论是否串联，子 agent 的 span 都会带 `dsh.session.parent_id` 属性，因此**仍可按父会话 ID 过滤或聚合子 span**——即使它们落在不同 trace 中。

**span 命名**：子 agent 收到 `subagent/catalog` 名称时用该名称（如 `invoke_agent researcher`）；拿不到名称时统一兜底为 `invoke_agent subagent`，不会回退成父 agent 的名字——否则父子 span 同名，在 APM 列表里无法区分。

若场景中存在"父 turn 结束后子 agent 才启动"的异步委派，分析时请以 `dsh.session.parent_id` 为准，而非仅看 trace 层级。

## 运行配置

运行时读取 `~/.dsh/plugins/huaweicloud-agentarts-observation-dsh-plugin/config.json`（支持 `//` 注释），字段说明见 [config.example.json](config.example.json)。要点：

- `enabled`：总开关（false 时不采集）。
- `otel.*`：APM/AOM 端点、认证信息与 AgentArts 控制台参数；`agentarts_agentops_otel_agent_apm_enable` / `..._aom_enable` 分别控制 trace / metric 上报。
- `features.captureMessageContent`：是否采集消息内容（关闭后不上报 `gen_ai.input/output.messages`、工具参数/结果文本等）。配置脚本可直接切换：`-NoMessageContent` / `--no-message-content`（关闭）、`-CaptureMessageContent $true` / `--capture-message-content true`（开启）。关闭时 `skill` 工具仍会上报**仅含技能名**的参数，用于技能维度识别。
- `features.debug`：开启后写 DEBUG 明细日志。
- `features.logRetentionDays`：按天保留 `data/logs` 日志，超期自动删除（默认 14，`0` 关闭清理）。

**启动校验**：插件加载时对 config.json 做字段校验，问题以 `[agentarts-dsh] config warning [字段]: ...` 形式输出到 DSH 主日志与文件日志：未知键给出最近键拼写建议（如 `agent_nam` → `agent_name`）、APM/AOM 开启但必填项缺失、已废弃的 `resource_type` / `resource_version`（资源类型固定 `agent`、资源版本取 DSH 版本，配置里写了会被忽略）、`features` 字段类型错误等。均为告警级，不阻止运行。

**热重载**：运行期修改 config.json 后（300ms 防抖），`features.*`（debug / captureMessageContent / linkSubagentTrace / logRetentionDays）与 `agent_name` 即时生效，无需重启；`otel`、`enabled`、`outputDir`、`user.id` 的变更只提示「需重启 DSH 生效」（OTel 管线与 userId 在构造期绑定）。解析失败时保持当前配置并告警。

配置由安装脚本从命令行参数生成/合并（保留无关字段，写入前备份）；也可手工维护。

**凭据处理**：脚本写入 `config.json` 后会自动收紧文件权限（Windows 下移除继承，仅保留当前用户、SYSTEM、Administrators；Linux/macOS 下 `chmod 600`），历史备份同样处理，并只保留最近 5 份备份——备份同样含明文凭据。凭据也可以通过环境变量 `DSH_AGENTARTS_APM_TOKEN` / `DSH_AGENTARTS_AOM_ACCESS_CODE` 提供，避免出现在命令行（会被 shell 历史与进程列表记录）。

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

## 开发

```sh
pnpm install        # 或 npm install（依赖仅在开发/打包期使用，运行时零依赖）
pnpm build          # tsc 类型检查 + 编译（dist/*.js，测试用）→ esbuild 打包 dist/plugin.mjs
pnpm test           # node --test dist/test/*.test.js（先 build）
pnpm typecheck      # 仅类型检查
```

- 版本号唯一事实来源是 `package.json`；`build.mjs` 会把它写入 `src/probe-version.generated.ts` 再打包。
- 修改源码后重新 `pnpm build`，产物即 `dist/plugin.mjs`。

## 打包发布

```sh
pnpm pack:bundle    # npm pack + 重命名 → huaweicloud-agentarts-observation-dsh-plugin-<version>.tgz
```

npm 产物名为 `huaweicloud-agentarts-observation-dsh-plugin-<version>.tgz`（`scripts/pack.mjs` 会校验并归一化文件名）。

### 发布流水线

```sh
npm run release              # 完整流程
node scripts/release.mjs --dry-run   # 只检查不写索引
```

依次执行：构建（tsc + esbuild）→ **产物漂移校验** → 全量测试 → 打包清单校验 → 生成插件市场索引。

**产物漂移校验**是本流水线的核心：`dist/plugin.mjs` 作为分发产物入库，DSH 从 Git 安装时直接使用它、不会构建。若改了 `src/` 却忘记重新构建提交，用户会装到旧逻辑，而肉眼极难发现。脚本会重新构建并与仓库中的产物比对，不一致即失败并要求提交。

其余校验：`files` 清单每一项都存在、产物含 `createRequire` banner（缺失会导致宿主加载失败）、`dsh.bundle.patch` 指向的文件存在。

发布流程：

```sh
git add -A && git commit -m "chore: 发布 v1.0.0"
git tag v1.0.0
node scripts/release.mjs --commit "$(git rev-parse v1.0.0)"   # 让索引精确指向发布提交
git add market/index.json && git commit -m "chore: 更新索引指向 v1.0.0"
git push origin HEAD --tags
```

插件市场索引说明见 [market/README.md](market/README.md)。

## 安装与配置

接入分三步：**安装插件 → 配置接入信息 → 重启 DSH**。面向最终用户的完整流程
（参数获取、desktop/web 差异、验证与排障）见 [docs/接入指导.md](docs/接入指导.md)。

### 步骤一：安装插件

插件发布在插件市场与 npm 仓库，包名 `huaweicloud-agentarts-observation-dsh-plugin`。

**desktop 形态**：在 DSH 客户端 **Plugins** → **Discover**（插件市场）安装，或在 **Add plugin** 中按包名安装。

> desktop profile 由桌面客户端独占管理，命令行 `dsh plugin --profile desktop add` 会被拒绝。

**web 形态**：

```sh
dsh plugin --profile web add huaweicloud-agentarts-observation-dsh-plugin
```

bundle 行由 [cordis.patch.yml](cordis.patch.yml) 提供；安装后重启 DSH 以加载新模块代。

### 步骤二：配置接入信息

`configure/` 目录下的脚本**只写配置**，不安装插件、不改动 profile：

```powershell
# Windows
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass   # 仅当前窗口
.\configure\dsh-agentarts-plugin.ps1 -AgentId <id> -ProjectId <id> `
  -Endpoint https://apm-access.<region>.myhuaweicloud.com -Token <token> `
  -AomEndpoint https://aom-access.<region>.myhuaweicloud.com `
  -AomAccessCode <code> -AomPrometheusId <id> -AgentName <name>
```

```sh
# Linux / macOS / WSL
./configure/dsh-agentarts-plugin.sh --agent-id <id> --project-id <id> \
  --endpoint https://apm-access.<region>.myhuaweicloud.com --token <token> \
  --aom-endpoint https://aom-access.<region>.myhuaweicloud.com \
  --aom-access-code <code> --aom-prometheus-id <id> --agent-name <name>
```

也可以直接手工编辑 `~/.dsh/plugins/huaweicloud-agentarts-observation-dsh-plugin/config.json`
（模板见 [config.example.json](config.example.json)）。

查看当前配置摘要（不打印凭据内容）：

```powershell
.\configure\dsh-agentarts-plugin.ps1 status
```

关闭会话内容采集（敏感场景，热生效，无需重启）：

```powershell
.\configure\dsh-agentarts-plugin.ps1 -NoMessageContent
```

```sh
./configure/dsh-agentarts-plugin.sh --no-message-content
```

> **上报地址格式**：不做格式校验，`https://host`、`host:443`、`10.x.x.x:4317` 等写法都可以。
> 缺少协议或端口时由插件的 `toGrpcUrl` 补全：域名补 `https://`、带端口按 443/其他区分 https/http、裸 IPv4 补 `:4317`。

### 步骤三：重启 DSH

`otel` 段在插件加载时绑定 OTLP 管线，**不支持热更新**，配置后必须重启（desktop 完全退出客户端，
web 重启 `dsh web` 进程）。`features.*` 与 `agent_name` 支持热生效。

### 卸载

插件卸载由 DSH 自身完成：desktop 在 **Plugins** 页卸载，web 执行
`dsh plugin --profile web remove huaweicloud-agentarts-observation-dsh-plugin`。
配置文件不随卸载删除，如需清理请手动删除
`~/.dsh/plugins/huaweicloud-agentarts-observation-dsh-plugin/`。

### 为什么 `dist/plugin.mjs` 要入库

DSH 从 Git 安装时拉的是**源码，不会运行构建**（`.gitignore` 中 `dist/*` 被忽略、仅保留 `dist/plugin.mjs`）。把构建产物提交进仓库，用户安装后即可直接加载，无需：

- 授权 pnpm 在安装期执行 `prepare` 脚本（`allowBuilds`）
- 访问 npm registry 下载 typescript / esbuild

本包是零运行时依赖的单文件 bundle，因此产物入库后 Git 安装只需要一次 clone。

## 兼容性

- DSH：`engines.dsh = >=0.2.1-rc.2`（安装时校验，不设上界）。
- Node：`>= 24.9.0`。

## 端到端验证记录（2026-11-18，华为云 cn-southwest-2）

真实环境验证结论，可作为后续回归基线：

| 层 | 内容 | 结果 |
|---|---|---|
| 数据面 | 真实 coordinator + 真实 OTel 管线 → 真实 APM/AOM 端点 | APM trace、AOM metric 均导出成功（AOM 12–18 datapoint） |
| 组合面 | `install_bundle` 装入 desktop profile | `application: applied`，插件在真实 DSH 进程中加载成功 |
| 真机面 | 安装脚本装入 Desktop，重启后跑真实对话 | **trace 成功送达 APM**：9 个 span，root span `invoke_agent zsh_DSH` |

### 该环境的网络特征（重要）

到 `apm-access.cn-southwest-2` / `aom-access.cn-southwest-2` 的 TCP 443 建链成功率实测仅 **2/6 ~ 5/12**，失败均为 `connect ETIMEDOUT`（单次约 21 秒）。由此产生两处针对性设计：

1. **`timeoutMillis: 30000`**（默认 10s 不够完成 TCP+TLS+HTTP/2 建链）
2. **导出失败重试 3 次，退避 2s/8s**：`BatchSpanProcessor` 与 `PeriodicExportingMetricReader` 在导出失败时会直接丢弃整批数据；退避必须盖过 grpc-js 通道自身的重连退避，否则重试会复用坏通道并瞬时失败。

实测中一次失败丢失了 61 个 span，因此重试是必要的而非优化项。

### 排障提示

- 日志无任何导出记录 → 先确认该周期内是否真的记录过指标（`PeriodicExportingMetricReader` 在 `scopeMetrics` 为空时会静默跳过导出）
- `DEADLINE_EXCEEDED` / `UNAVAILABLE` → 链路抖动，看是否出现 `export failed, retrying in …ms` 后跟 `SUCCESS`
- 重试用的是同一批 span，不会产生重复 trace

## 后续优化方向

已完成：

- [x] 2026-11-18 清理未使用变量（`closeTurn` 的 `finishReason`；`otel-reporter` 的 `idGenerator`/`otelConfig`/模块级 `meter`）。
- [x] 2026-11-18 日志量治理：AOM 导出明细（全量 dataPoints）仅在 `debug` 开启时收集；per-step 时间戳明细与 LLM/tool span 前置详情降级 DEBUG；新增日志按天保留（`features.logRetentionDays`，默认 14 天，`0` 关闭）。
- [x] 2026-11-18 config.json 配置校验 + 热重载：启动时校验字段（未知键给最近键拼写建议、APM/AOM 必填项、类型与取值）；运行期 `features.*` 与 `agent_name` 热生效，`otel`/`enabled`/`outputDir`/`user.id` 变更提示需重启；解析失败保持当前配置。
- [x] 2026-11-18 OTel 层类型化：`otel-reporter.ts` 的 `tracerProvider`/`meterProvider`/`tracer`/`Span`/导出回调/`setAttr` 全部改用 `@opentelemetry/api`、`sdk-trace-base`、`sdk-metrics`、`@opentelemetry/core`（新增显式 devDependency）的真实类型，`any` 归零；`setStatus` 改用 `SpanStatusCode.ERROR`；父 trace 串联改走官方 `trace.wrapSpanContext()`（行为等价，新增行为测试覆盖）。

待办：

- 与 DSH 相关的 `any`（`session`/`event.data`/LLM chunk/`options`，集中在 `coordinator.ts`、`mapping.ts`、`plugin.ts`）保持现状，见下方「等触发条件」。

等触发条件的待办（2026-11-18 评估，暂缓）：

- [ ] DSH 事件负载类型化 + `strict` 模式。
  - **运行时影响为零**：类型在编译期擦除，插件行为、性能、上报结果均不变；收益仅在开发期（改 coordinator 生命周期逻辑时的字段名/结构检查、IDE 补全）。
  - **代价**：类型只能来自 DSH 源码快照（需随 DSH 升级人工同步）或 `import type` 直接依赖 dsh 包（构建与 DSH 版本耦合）。当前宿主为 `0.2.x-rc`，事件结构仍可能变动。
  - **现状是健壮的**：插件作为观察者，靠 `?.`、`??`、`=== undefined` 防御性读取，宿主字段变动时运行时通常继续工作。
  - **触发条件（任一满足再做）**：① 需要对 `coordinator.ts` 做实质性重构；② DSH API 稳定（脱离 rc）；③ 多人协作维护该插件。

按产品决定暂不处理（2026-11-18）：

- [⏸] AOM 点号/下划线双命名指标收敛——保持双命名上报，待 AOM 平台侧验证出指标名转换结论后再决定去留。
- [⏸] trace 采样——保持全量采集，不加采样开关。
