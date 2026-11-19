# 安全审查记录

本文记录本插件的安全审查范围、发现的问题与修复方式，供后续维护者参考。
审查对象是仓库内的插件源码、构建产物、配置脚本与文档；不涉及 AgentArts 服务端。

## 审查方法

用本机真实配置值反向扫描仓库（不把任何凭据写入新文件），配合静态检查：

1. 按凭据形态扫描硬编码（token / access code / 私钥 / AK-SK 等模式）
2. 用 `config.json` 中的真实 token、access code、租户 ID 逐文件比对仓库内容
3. 检索 git 全量历史，确认敏感文件与长密钥串从未被提交
4. 检查运行日志与构建产物是否包含凭据、构建机绝对路径、主机名或用户名
5. 检查配置脚本如何处理凭据（命令行、临时文件、落盘权限、备份）
6. 检查插件是否使用了 `eval` / `new Function` / `child_process` 等危险 API
7. `npm audit` 检查依赖漏洞

## 已修复的问题

### 1. 依赖漏洞（中危，已清零）

`npm audit` 曾报告 12 个 moderate，根因两处：

| 包 | 问题 | 是否进入产物 |
|---|---|---|
| `@opentelemetry/core < 2.8.0` | W3C Baggage propagation 无界内存分配（DoS） | **是**——被内联进 `dist/plugin.mjs` |
| `esbuild <= 0.24.2` | 开发服务器可被任意站点请求 | 否——仅构建期 |

修复：升到 `core/resources/sdk-*/context-async-hooks 2.12.1` +
`exporter-*-otlp-grpc 0.223.2` + `esbuild 0.28.2`，`npm audit` 归零。

**版本约束（升级时务必注意）**：

- `@opentelemetry/api` 必须保持 `1.9.1`。`sdk-metrics` 要求 `>=1.9.0 <1.10.0`，
  `sdk-trace-base` 要求 `<1.10.0`，升到 1.10 会同时违反两者。
- 不要混用 3.x 的 `core`/`sdk-metrics` 与 2.x 的 `sdk-trace-base`：两者依赖的
  `core` 主版本不同，打包产物里会出现两份 `@opentelemetry/core`，单例状态分裂。
- exporter 从 `0.220.0` 起改为依赖聚合包 `@opentelemetry/sdk-trace`（此前依赖
  `sdk-trace-base`），选版本时要按这条线对齐。

### 2. config.json 权限未收紧（中危）

凭据以明文存放在 `~/.dsh/plugins/<包名>/config.json`，此前完全依赖继承的默认
权限。Linux 下默认 `umask 022` 产生 `644`，多用户主机上任何用户可读。

修复：配置脚本写入后自动收紧。

- Windows：`icacls /inheritance:r` 后只授予当前用户、`SYSTEM`、`Administrators`
- Linux/macOS：目录 `700`、文件 `600`

**为什么用 SID 而不是组名**：`Administrators`、`SYSTEM` 在多语言系统上显示名
不同（如中文系统的本地化名称），用组名会匹配失败。因此传
`*S-1-5-32-544`、`*S-1-5-18`。

### 3. 凭据经命令行传递（中危）

`-Token` / `--token` 会进入 shell 历史（PowerShell 的 `ConsoleHost_history.txt`、
bash 的 `.bash_history`）与进程列表。

修复：支持环境变量 `DSH_AGENTARTS_APM_TOKEN`、`DSH_AGENTARTS_AOM_ACCESS_CODE`；
若仍通过命令行传参，脚本会告警提示该风险。

### 4. 临时文件在失败路径残留（中危）

写入配置时需要一份中间 JSON，其中含明文 token 与 access code，落在系统临时目录。
原实现把清理语句放在子进程调用之后，失败 `exit` 时会跳过删除。

修复：ps1 改为 `try/finally`（PowerShell 的 finally 在 `exit` 时仍执行），
bash 版加 `trap ... EXIT`。

### 5. 备份文件无限累积（低危）

每次写配置都会生成一份 `config.json.bak.<时间戳>`，同样含明文凭据。长期使用会在
磁盘上累积任意多份凭据副本。

修复：只保留最近 5 份，其余删除；**先清理再收紧权限**（避免为即将删除的文件做
无用功）。

### 6. `.gitignore` 未忽略 `config.json`（低危）

若开发者把真实配置放进包目录做测试，会被 git 捕获。

修复：忽略 `config.json` 与 `config.local.json`；模板 `config.example.json`
仍受版本控制。

## 已确认无问题的项

- 源码、脚本、文档、locale 中无硬编码凭据（唯一疑似匹配是内联 OTel SDK 的
  `GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for(...)`，与凭据无关）
- git 全量历史中无凭据、无私钥、无 `.env` 等敏感文件
- 运行日志不含 token / access code（已用真实值比对）
- 构建产物中无构建机绝对路径、用户名、主机名
- 插件运行期不使用 `eval` / `new Function` / `child_process`
- 凭据仅用于 gRPC metadata（`authentication`、`authorization: Bearer`），
  **不进入任何 span 属性**，不会随 telemetry 上送
- 远端地址未内嵌凭据

## 残余风险（有意保留，需使用者知情）

1. **会话内容默认外发**：`features.captureMessageContent` 默认 `true`，会上报用户
   消息、助手回复、系统提示词、工具调用的参数与结果。这是产品设计选择，已在
   README、`config.example.json` 与插件描述中显著提示，并支持关闭。
2. **设备标识**：`user.id` 未配置时取主机名。建议显式设置 `user.id`。
   （此前上报的 `agent.dsh.cwd` 工作目录已按要求移除，不再外发本地路径。）
3. **凭据为明文文件**：未接入 Windows DPAPI / macOS Keychain 等系统密钥库。
   当前用"文件权限收紧"控制访问面。
4. **TLS 未做证书 pinning**：使用系统根证书校验（grpc-js 默认），未固定证书。
   属常规做法；若部署环境要求 pinning 需另行实现。

## 复现本次审查

```sh
cd agentarts-instrumentation-dsh

# 依赖漏洞
npm audit

# 危险 API
grep -rn "eval(\|new Function\|child_process" src/

# 仓库中是否出现真实凭据（用本机 config.json 的值比对）
#   见审查时使用的扫描脚本思路：读取 config.json，逐文件 includes() 比对

# git 历史中的敏感文件
git log --all --pretty=format: --name-only --diff-filter=A | sort -u | \
  grep -Ei 'config\.json$|app-key|\.env$|\.pem$|secret|credential'
```

## 维护建议

- 升级 OTel 依赖时，先核对 `peerDependencies` 再改版本，避免 api/core 主版本冲突
  （见上文「版本约束」）
- 修改配置脚本时，保持 ps1 与 sh 行为一致；两者均为含中文的 UTF-8 文件
  （ps1 带 BOM，PowerShell 5.1 依赖 BOM 正确读取中文），改动请用显式 UTF-8
  读写工具，勿用会按系统 ANSI 转码的方式重写
- 任何时候不要把真实 `config.json` 放进仓库
