// 环境变量配置测试：键名环境变量覆盖、${VAR} 占位符展开与布尔归一化。
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


test("配置文件不存在时，otel 仍可由键名环境变量提供", () => {
  const missing = path.join(os.tmpdir(), "agentarts-not-exist", "config.json")
  withEnv(
    {
      agentarts_agentops_otel_agent_apm_enable: "true",
      agentarts_agentops_apm_exporter_endpoint: "https://env.example",
      agentarts_agentops_apm_token: "env-token"
    },
    () => {
      const config = loadConfig(missing)
      assert.equal(config.otel.agentarts_agentops_otel_agent_apm_enable, true)
      assert.equal(config.otel.agentarts_agentops_apm_exporter_endpoint, "https://env.example")
      assert.equal(config.otel.agentarts_agentops_apm_token, "env-token")
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


test("键名环境变量：直接覆盖 otel 字段", () => {
  withConfigFile(
    { otel: { agentarts_agentops_otel_agent_apm_enable: false, agentarts_agentops_apm_exporter_endpoint: "https://file.example" } },
    (configPath) => {
      withEnv(
        {
          agentarts_agentops_otel_agent_apm_enable: "true",
          agentarts_agentops_apm_exporter_endpoint: "https://env.example",
          agentarts_agentops_apm_token: "env-token"
        },
        () => {
          const config = loadConfig(configPath)
          assert.equal(config.otel.agentarts_agentops_otel_agent_apm_enable, true)
          assert.equal(config.otel.agentarts_agentops_apm_exporter_endpoint, "https://env.example")
          assert.equal(config.otel.agentarts_agentops_apm_token, "env-token")
        }
      )
    }
  )
})

test("键名环境变量：布尔值支持 true/false/1/0/yes/no", () => {
  for (const [raw, expected] of [
    ["true", true],
    ["FALSE", false],
    ["1", true],
    ["0", false],
    ["yes", true],
    ["no", false]
  ] as const) {
    withConfigFile({ otel: {} }, (configPath) => {
      withEnv({ agentarts_agentops_otel_agent_aom_enable: raw }, () => {
        const config = loadConfig(configPath)
        assert.equal(
          config.otel.agentarts_agentops_otel_agent_aom_enable,
          expected,
          `${raw} 应解析为 ${expected}`
        )
      })
    })
  }
})

test("键名环境变量：非法布尔值被忽略，保留原配置", () => {
  withConfigFile({ otel: { agentarts_agentops_otel_agent_apm_enable: true } }, (configPath) => {
    withEnv({ agentarts_agentops_otel_agent_apm_enable: "maybe" }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.otel.agentarts_agentops_otel_agent_apm_enable, true, "非法值不应覆盖")
    })
  })
})


test("键名环境变量：AOM 相关四个字段均可覆盖", () => {
  withConfigFile({}, (configPath) => {
    withEnv(
      {
        agentarts_agentops_otel_agent_aom_enable: "true",
        agentarts_agentops_aom_exporter_endpoint: "https://aom.example",
        agentarts_agentops_aom_access_code: "aom-code",
        agentarts_agentops_aom_prometheus_id: "prom-1"
      },
      () => {
        const config = loadConfig(configPath)
        assert.equal(config.otel.agentarts_agentops_otel_agent_aom_enable, true)
        assert.equal(config.otel.agentarts_agentops_aom_exporter_endpoint, "https://aom.example")
        assert.equal(config.otel.agentarts_agentops_aom_access_code, "aom-code")
        assert.equal(config.otel.agentarts_agentops_aom_prometheus_id, "prom-1")
      }
    )
  })
})

test("布尔归一化：配置里写成字符串 \"true\" 也按 true 处理", () => {
  withConfigFile({ otel: { agentarts_agentops_otel_agent_apm_enable: "true" } }, (configPath) => {
    withEnv({}, () => {
      const config = loadConfig(configPath)
      assert.equal(config.otel.agentarts_agentops_otel_agent_apm_enable, true, "字符串 true 应转为布尔 true")
    })
  })
})

test("布尔归一化：文件里 features 写成字符串 \"false\" 不会被视为真值（隐私）", () => {
  withConfigFile({ features: { captureMessageContent: "false" }, otel: {} }, (configPath) => {
    withEnv({ }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.features.captureMessageContent, false, "字符串 false 必须转成布尔 false")
    })
  })
})

test("布尔归一化：占位符展开成 \"false\" 后仍然生效", () => {
  withConfigFile({ features: { debug: "\${FLAG_DEBUG}" }, otel: {} }, (configPath) => {
    withEnv({ FLAG_DEBUG: "false" }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.features.debug, false)
    })
  })
})

test("布尔归一化：非法值回退默认值并告警", () => {
  withConfigFile({ features: { captureMessageContent: "maybe" }, otel: {} }, (configPath) => {
    withEnv({ }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.features.captureMessageContent, true, "回退到默认值 true")
    })
  })
})

test("键名环境变量：captureMessageContent 可关闭输入输出采集", () => {
  withConfigFile({ features: { captureMessageContent: true }, otel: {} }, (configPath) => {
    withEnv({ captureMessageContent: "false" }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.features.captureMessageContent, false, "环境变量应能关闭采集")
    })
  })
})

test("键名环境变量：debug 与 linkSubagentTrace 同样可覆盖", () => {
  withConfigFile({ features: { debug: false, linkSubagentTrace: true }, otel: {} }, (configPath) => {
    withEnv({ debug: "true", linkSubagentTrace: "0" }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.features.debug, true)
      assert.equal(config.features.linkSubagentTrace, false)
    })
  })
})

test("键名环境变量：features 非法布尔值被忽略并保留原配置", () => {
  withConfigFile({ features: { captureMessageContent: false }, otel: {} }, (configPath) => {
    withEnv({ captureMessageContent: "maybe" }, () => {
      const config = loadConfig(configPath)
      assert.equal(config.features.captureMessageContent, false, "非法值不应覆盖")
    })
  })
})
