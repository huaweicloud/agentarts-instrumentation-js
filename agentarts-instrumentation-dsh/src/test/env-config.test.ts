// 环境变量配置注入测试：DSH_AGENTARTS_CONFIG 深合并覆盖与 ${VAR} 占位符展开。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "../config.js"

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key]
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  try {
    fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function withConfigFile(body: unknown, fn: (configPath: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentarts-env-"))
  const configPath = path.join(dir, "config.json")
  fs.writeFileSync(configPath, JSON.stringify(body), "utf8")
  try {
    fn(configPath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("DSH_AGENTARTS_CONFIG：JSON 深合并覆盖文件配置的任意字段", () => {
  withConfigFile(
    { enabled: true, agent_name: "from-file", features: { debug: false, captureMessageContent: true }, otel: { agentarts_agentops_apm_token: "file-token", agentarts_agentops_apm_exporter_endpoint: "https://file.example" } },
    (configPath) => {
      withEnv(
        {
          DSH_AGENTARTS_CONFIG: JSON.stringify({
            agent_name: "from-env",
            features: { debug: true },
            otel: { agentarts_agentops_apm_token: "env-token" }
          })
        },
        () => {
          const config = loadConfig(configPath)
          assert.equal(config.agent_name, "from-env", "标量被环境变量覆盖")
          assert.equal(config.features.debug, true, "嵌套对象深合并")
          assert.equal(config.features.captureMessageContent, true, "未覆盖的同层字段保留")
          assert.equal(config.otel.agentarts_agentops_apm_token, "env-token", "嵌套字段被覆盖")
          assert.equal(config.otel.agentarts_agentops_apm_exporter_endpoint, "https://file.example", "未覆盖字段保留")
        }
      )
    }
  )
})

test("DSH_AGENTARTS_CONFIG：文件不存在时也能完全由环境变量提供配置", () => {
  const missing = path.join(os.tmpdir(), "agentarts-not-exist", "config.json")
  withEnv(
    {
      DSH_AGENTARTS_CONFIG: JSON.stringify({
        enabled: true,
        agent_name: "env-only",
        otel: { agentarts_agentops_otel_agent_apm_enable: true, agentarts_agentops_apm_exporter_endpoint: "https://env.example" }
      })
    },
    () => {
      const config = loadConfig(missing)
      assert.equal(config.agent_name, "env-only")
      assert.equal(config.otel.agentarts_agentops_otel_agent_apm_enable, true)
      assert.equal(config.otel.agentarts_agentops_apm_exporter_endpoint, "https://env.example")
    }
  )
})

test("占位符 \${VAR}：已定义变量被展开", () => {
  withConfigFile(
    { otel: { agentarts_agentops_apm_token: "\${MY_TOKEN}", agentarts_agentops_apm_exporter_endpoint: "https://\${MY_HOST}/apm" } },
    (configPath) => {
      withEnv({ MY_TOKEN: "secret-value", MY_HOST: "apm.example" }, () => {
        const config = loadConfig(configPath)
        assert.equal(config.otel.agentarts_agentops_apm_token, "secret-value")
        assert.equal(config.otel.agentarts_agentops_apm_exporter_endpoint, "https://apm.example/apm")
      })
    }
  )
})

test("占位符 \${VAR}：未定义变量保留原样，不静默变空", () => {
  withConfigFile({ otel: { agentarts_agentops_apm_token: "\${UNDEFINED_TOKEN_XYZ}" } }, (configPath) => {
    withEnv({ UNDEFINED_TOKEN_XYZ: undefined }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.otel.agentarts_agentops_apm_token, "\${UNDEFINED_TOKEN_XYZ}")
    })
  })
})

test("DSH_AGENTARTS_CONFIG 非法 JSON 时忽略并保留文件配置", () => {
  withConfigFile({ agent_name: "file-name" }, (configPath) => {
    withEnv({ DSH_AGENTARTS_CONFIG: "{not-json" }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.agent_name, "file-name")
    })
  })
})
