// 上报地址归一化测试：生产用 https 域名，内网用明文 IP:端口
import { test } from "node:test"
import assert from "node:assert/strict"
import { toGrpcUrl } from "../otel-reporter.js"

test("toGrpcUrl：已带协议的地址原样保留", () => {
  assert.equal(
    toGrpcUrl("https://apm-access.cn-southwest-2.myhuaweicloud.com"),
    "https://apm-access.cn-southwest-2.myhuaweicloud.com"
  )
  assert.equal(toGrpcUrl("http://10.0.0.1:4317"), "http://10.0.0.1:4317")
})

test("toGrpcUrl：生产域名（无协议、无端口）推断为 https", () => {
  assert.equal(
    toGrpcUrl("aom-access.cn-southwest-2.myhuaweicloud.com"),
    "https://aom-access.cn-southwest-2.myhuaweicloud.com"
  )
})

test("toGrpcUrl：带端口的内网地址推断为 http 明文", () => {
  assert.equal(toGrpcUrl("10.0.0.1:4317"), "http://10.0.0.1:4317")
  assert.equal(toGrpcUrl("localhost:4317"), "http://localhost:4317")
})

test("toGrpcUrl：无端口非域名（如 localhost）保持 http", () => {
  assert.equal(toGrpcUrl("localhost"), "http://localhost")
})

test("toGrpcUrl：空值原样返回", () => {
  assert.equal(toGrpcUrl(""), "")
  assert.equal(toGrpcUrl(undefined), "")
})
