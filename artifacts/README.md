# 安装包下载（artifacts）

本目录提供可直接下载安装的插件产物，便于在无法访问 npm registry 的环境中使用。

| 文件 | 说明 |
|---|---|
| `huaweicloud-agentarts-observation-dsh-plugin-1.0.0.tgz` | DSH 观测插件安装包 |
| `SHA256SUMS` | 上述产物的 SHA256 校验值 |

## 版本信息

- 插件版本：**1.0.0**
- 适用 DSH：**>= 0.2.1-rc.2**
- 对应源码提交：见同一次提交（`git log -1 -- artifacts/`）

## 校验下载完整性

```bash
# Linux / macOS
sha256sum huaweicloud-agentarts-observation-dsh-plugin-1.0.0.tgz
# 与 SHA256SUMS 中的值对比

# Windows（PowerShell）
Get-FileHash .\huaweicloud-agentarts-observation-dsh-plugin-1.0.0.tgz -Algorithm SHA256
```

## 安装

插件按 DSH profile 安装。桌面客户端（`desktop`）的 profile 由 Electron 独占管理，
命令行会被拒绝，请在客户端 **Plugins → Discover / Add plugin** 中安装本地 tgz。

命令行形态（如 `web`）：

```bash
dsh plugin --profile web add "file:<下载后的 tgz 绝对路径>"
```

```powershell
dsh plugin --profile web add "file:<下载后的 tgz 绝对路径>"
```

安装后按 [接入指导](../agentarts-instrumentation-dsh/docs/接入指导.md) 的「步骤二」
用包内脚本写入接入信息，然后重启 DSH。

## 下载地址

在分支 `feat/dsh-plugin` 上，可直接用如下地址（分支合并到 `main` 后请相应替换）：

```
https://github.com/huaweicloud/agentarts-instrumentation-js/raw/feat/dsh-plugin/artifacts/huaweicloud-agentarts-observation-dsh-plugin-1.0.0.tgz
```

```bash
curl -fL -o huaweicloud-agentarts-observation-dsh-plugin-1.0.0.tgz \
  https://github.com/huaweicloud/agentarts-instrumentation-js/raw/feat/dsh-plugin/artifacts/huaweicloud-agentarts-observation-dsh-plugin-1.0.0.tgz
```

> 该目录存放的是构建产物，随版本更新替换；历史版本可从 git 历史中取回。
