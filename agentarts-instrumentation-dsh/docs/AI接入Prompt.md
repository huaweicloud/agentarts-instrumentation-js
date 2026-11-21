# DSH 接入 AgentArts 观测 · AI 执行指令

> 用法：把下面「指令正文」整段复制给 AI（DSH 中的会话或任意具备命令执行能力的助手），
> 它会按步骤完成安装与配置，并在需要你操作时明确说明。
>
> 接入指导文档中已内嵌按操作系统区分的 AI 辅助接入提示词，见
> [接入指导.md](接入指导.md#ai-辅助接入)；本文档是同一内容的通用版本。

---

## 指令正文（从此行开始复制）

你现在要帮我完成一件事：**把当前 DSH（DeepSeek Harness）接入华为云 AgentArts 观测平台**，
实现调用链（trace → APM）自动上报。

请严格按下述流程执行。每个阶段结束后先自检，再进入下一阶段；任何一步失败都要停下来
报告具体错误，**不要凭猜测修改配置或跳过验证**。

### 安全红线（必须遵守）

1. **不要打印、回显、记录我提供的 Token**。日志里出现也要脱敏。
2. 优先用环境变量传凭据（`DSH_AGENTARTS_APM_TOKEN`），避免写进命令行历史。
3. 不要修改与本次任务无关的配置；改动 `cordis.patch.yml` 或 `package.json` 前先备份。
4. 需要重启 DSH 时**不要自行重启**（会中断当前会话），改为告诉我操作方式。
5. 不确定的路径、版本、字段，先查证（读文件/看日志）再动手。

### 阶段 0：收集信息（先问我，别猜）

向我确认以下信息。**我没有提供的项不要编造**，直接问我要。

| 参数 | 是否必需 | 说明 |
|---|---|---|
| AgentArts 智能体 ID | 必需 | 控制台「观测与优化 > 观测 > 接入智能体」创建后获得 |
| APM 上报地址 | 必需 | 形如 `https://apm-access.<region>.myhuaweicloud.com` |
| APM Token | 必需 | 调用链上报凭证 |
| 账号 Domain ID | 建议 | |
| 智能体名称 | 可选 | 写入 `gen_ai.agent.name` |
| 是否上报会话内容 | 请我选择 | `true`（默认，含消息/提示词/工具参数结果）或 `false` |

同时请自行探测环境（用命令，不要问我）：

```powershell
# Windows
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object -ExpandProperty Name
```

```bash
# Linux / macOS
ls ~/.dsh/profiles
```

判定当前形态：

- profile 为 `desktop`（或你在桌面客户端里）→ **desktop 形态**
- profile 为 `web`（或由 `dsh web` 启动）→ **web 形态**

### 阶段 1：安装插件

包名：`huaweicloud-agentarts-observation-dsh-plugin`

**desktop 形态**

- 如果你有 `plugin_manager` 工具：用 `install_bundle` 安装该包（必要时先 `remove_bundle` 再装）。
- 否则**不要**执行 `dsh plugin --profile desktop add`（会被 Electron 独占拒绝），
  改为告诉我：在 DSH 客户端 **Plugins → Discover**（或 **Add plugin**）安装。

**web 形态**

```bash
dsh plugin --profile web add "<本地产物路径或 git+https 地址>"
```

安装后自检（必须通过再继续）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\<profile>\package.json" | Select-String "huaweicloud"
```

应能看到包名出现在 `dsh.profile.bundles` 中。若看不到，停止并报告实际输出。

### 阶段 2：写配置

配置脚本随插件分发，位于：

```
~/.dsh/profiles/<profile>/node_modules/huaweicloud-agentarts-observation-dsh-plugin/configure/
  dsh-agentarts-plugin.ps1   (Windows)
  dsh-agentarts-plugin.sh    (Linux/macOS)
```

**优先用环境变量传凭据**，再执行脚本（不传 `-Token` / `--token`）：

```powershell
$env:DSH_AGENTARTS_APM_TOKEN = "<APM Token>"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

& "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\huaweicloud-agentarts-observation-dsh-plugin\configure\dsh-agentarts-plugin.ps1" `
  -AgentId <id> `
  -DomainId <domain-id> `
  -Endpoint https://apm-access.<region>.myhuaweicloud.com `
  -AgentName <agent-name> `
  -CaptureMessageContent true
```

```bash
export DSH_AGENTARTS_APM_TOKEN="<APM Token>"

~/.dsh/profiles/<profile>/node_modules/huaweicloud-agentarts-observation-dsh-plugin/configure/dsh-agentarts-plugin.sh \
  --agent-id <id> --domain-id <domain-id> \
  --endpoint https://apm-access.<region>.myhuaweicloud.com \
  --agent-name <agent-name> \
  --capture-message-content true
```

要点：

- `-CaptureMessageContent` / `--capture-message-content` 取值 `true` / `false`；
  也可用 `-NoMessageContent` / `--no-message-content` 关闭内容上报。
- **不传**这两个开关时保持配置文件现有值，不会被重置。

配置写完后自检：

```powershell
& "...\configure\dsh-agentarts-plugin.ps1" status
```

应输出 `APM (traces) : on`、token 为 `(set, N chars)`（**只显示长度**）。

### 阶段 3：请我重启 DSH

- **desktop**：完全退出 DSH 桌面客户端（不是最小化）后重新打开
- **web**：在运行 `dsh web` 的终端按 `Ctrl+C`，重新执行 `dsh web`

原因：`otel` 段在插件加载时绑定上报管线，**必须重启**才生效；
`features.*`（含内容采集开关）属热生效。

### 阶段 4：重启后验证

日志路径：

```
Windows : %USERPROFILE%\.dsh\plugins\huaweicloud-agentarts-observation-dsh-plugin\data\logs\plugin-YYYY-MM-DD.log
Linux   : ~/.dsh/plugins/huaweicloud-agentarts-observation-dsh-plugin/data/logs/plugin-YYYY-MM-DD.log
```

**成功判据（按顺序检查）**

1. 出现 `plugin loaded successfully`
2. `config loaded` 中 `apmEnabled:true`
3. 出现 `APM (Traces) initialized`
4. 发起一轮真实对话后，出现 `APM (Traces) export SUCCESS`

看到 `export failed, retrying` 后跟 `SUCCESS` 属正常重试，数据不丢；
只有在**持续失败**时才需要报告。

### 阶段 5：失败排查顺序

按此顺序定位，每一步都要把**实际输出**贴给我：

1. **插件没加载**：profile 的 `dsh.profile.bundles` 是否含包名；`node_modules` 下是否有该包；
   是否真的重启过。
2. **配置缺失**：日志有无 `config warning [otel]: missing`；`status` 是否显示 `(not set)`。
3. **调用链无数据**：`apmEnabled` 是否 `true`；能否连通报端（`Test-NetConnection <host> -Port 443`）；
   是否完成了至少一轮对话。
4. **Windows 脚本无法运行**：`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`；
   若脚本来自网络下载，还需 `Unblock-File <脚本路径>`。

### 完成标准（全部满足才算接入成功）

- [ ] 插件已注册进当前 profile
- [ ] 配置文件中 `otel` 段关键字段齐全，`status` 显示 APM 为 on
- [ ] 重启后日志出现 `plugin loaded successfully` 与 `APM (Traces) initialized`
- [ ] 至少一轮对话产生 `APM (Traces) export SUCCESS`

### 最终输出格式

```
## 接入结果
- 形态/profile：desktop / web（具体名称）
- 插件版本：
- 上报开关：APM on/off，内容采集 on/off
- 验证：APM 导出 SUCCESS N 次
- 未解决项：（如有，附实际错误日志）
```

## 指令正文（到上一行为止）

---

## 使用建议

- 该 Prompt 假设 AI 具备命令执行能力；若只具备对话能力，它应把命令逐条给你、由你执行。
- 涉及凭据时，优先在环境变量里给，避免留在命令历史中。
