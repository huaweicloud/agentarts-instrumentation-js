// 上报地址归一化测试：覆盖域名/IP、带不带协议、带不带端口的各种写法。
// 原则：只补全缺省值，绝不拒绝输入。
import { test } from "node:test"
import assert from "node:assert/strict"
import { toGrpcUrl } from "../otel-reporter.js"

test("toGrpcUrl：已带协议的地址原样保留", () => {
  const cases = [
    "https://apm-access.cn-southwest-2.myhuaweicloud.com",
    "https://aom-access.cn-southwest-2.myhuaweicloud.com",
    "http://10.0.0.1:4317",
    "https://10.0.0.1:4317"
  ]
  for (const c of cases) assert.equal(toGrpcUrl(c), c, c)
})

test("toGrpcUrl：生产域名（无协议、无端口）推断为 https/443", () => {
  assert.equal(
    toGrpcUrl("aom-access.cn-southwest-2.myhuaweicloud.com"),
    "https://aom-access.cn-southwest-2.myhuaweicloud.com"
  )
})

test("toGrpcUrl：域名:端口 —— 443 用 https，其余用 http", () => {
  assert.equal(
    toGrpcUrl("apm-access.cn-southwest-2.myhuaweicloud.com:443"),
    "https://apm-access.cn-southwest-2.myhuaweicloud.com:443"
  )
  assert.equal(toGrpcUrl("example.com:8443"), "http://example.com:8443")
})

test("toGrpcUrl：IP:端口 推断为明文 http", () => {
  assert.equal(toGrpcUrl("10.0.0.1:4317"), "http://10.0.0.1:4317")
  assert.equal(toGrpcUrl("192.168.1.10:4318"), "http://192.168.1.10:4318")
  assert.equal(toGrpcUrl("10.0.0.1:443"), "https://10.0.0.1:443")
})

test("toGrpcUrl：裸 IPv4 补内网 gRPC 默认端口", () => {
  assert.equal(toGrpcUrl("10.0.0.1"), "http://10.0.0.1:4317")
})

test("toGrpcUrl：裸主机名与空值", () => {
  assert.equal(toGrpcUrl("localhost"), "http://localhost")
  assert.equal(toGrpcUrl(""), "")
  assert.equal(toGrpcUrl(undefined), "")
})

test("toGrpcUrl：不因格式异常而抛错（宽松处理）", () => {
  for (const c of ["  spaced.example.com  ", "bare-host", "1.2.3.4:0"]) {
    assert.doesNotThrow(() => toGrpcUrl(c), c)
  }
})
