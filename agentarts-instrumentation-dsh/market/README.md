# 插件市场索引

本目录存放 DSH 插件市场索引，由 `scripts/release.mjs` 生成，**不要手工编辑**。

## 什么是插件索引

DSH 的**插件市场**（Discover 标签）读取一个 JSON 索引来发现可安装的插件。索引本身
只是一个静态文件，指向真正的安装源：

```json
{
  "format": 1,
  "plugins": [{
    "name": "@cloud/huaweicloud-agentarts-observation-dsh-plugin",
    "versions": [{
      "version": "1.0.0",
      "source": { "type": "git", "url": "https://...", "commit": "<40-hex>", "path": "agentarts-instrumentation-dsh" }
    }]
  }]
}
```

`source.type` 只支持 `npm` 和 `git` 两种。本项目走 Git：`commit` 是完整 40 位 SHA，
`path` 是插件包在仓库中的子目录（本仓库为 `agentarts-instrumentation-dsh`）。

## 发布时如何更新

```sh
cd agentarts-instrumentation-dsh
npm run release          # 构建 + 校验 + 测试 + 重新生成 index.json
```

索引里的 `commit` 取自生成时的 HEAD，因此**先提交、再打 tag、最后生成索引**能保证
索引精确指向发布提交：

```sh
git add -A && git commit -m "chore: 发布 v1.0.0"
git tag v1.0.0
node scripts/release.mjs --commit "$(git rev-parse v1.0.0)"
git add market/index.json && git commit -m "chore: 更新索引指向 v1.0.0"
git push origin HEAD --tags
```

## 如何托管

索引是静态文件，放到任何支持 https 的静态主机即可（GitHub Pages、对象存储等）。
`icon` 字段为相对路径，相对**索引文件自身**解析，因此索引与图标必须保持相对位置。

若用 GitHub Pages 托管，需把本目录（及包根下的 `icon.svg`）发布出去；索引里的
`icon: "../icon.svg"` 会解析到包根的图标。

## 用户如何添加

1. 打开 **Plugins** 页，在 **Experimental plugins** 中开启 **Custom plugin indexes**
2. 切到 **Discover** 标签，选择 **Add index source**
3. 填入索引的 https 地址

索引地址必须使用 `https:`（`http:` 可被中间人篡改，从而替换安装源）。
