# uploadbroker-cf

UploadBroker 的 Cloudflare Workers + R2 专用实现。保留上传接口、临时资源 URL、鉴权和去重语义；图片默认支持 **50 MB**。文件和元数据全部保存在一个私有 R2 bucket，无 Go、SQLite 或服务器依赖。

```text
Client / Platform → Worker → private R2 bucket
```

原项目：https://github.com/doc-war/uploadbroker 。原项目分析、迁移规划和并发设计见 [docs/design.md](docs/design.md)。项目名已改为 uploadbroker-cf，当前工作目录保留原名称 uploadbroker-js。

## 本地运行

需要 Node.js 22+。

```powershell
npm ci
npm run config:init
# 编辑 deploy/wrangler.jsonc 中的配置和密钥；已有文件不会被覆盖
npm run dev
```

本地 R2 由 Wrangler 模拟，不需要创建线上 bucket。`npm test` 会构建 Worker，再使用 workerd 和本地 R2 运行协议与 50 MB 集成测试。`npm run build` 仅 dry-run，不发布。

## API

| 接口 | 方法 | 说明 |
|---|---|---|
| `/v1/upload` | POST | multipart/form-data，`file`、可选 `expires`、`sign`、`timestamp` |
| `/tmp/{expire}/{shard}/{key}/{token}.{ext}` | GET | 签名临时资源 URL |
| `/v1/health` | GET | R2 状态和有效对象数量 |

`expires` 是 1～24 小时，默认 24。配置 hmac_secret 后，sign 必须是 `HMAC-SHA256(secret,timestamp)` 的小写十六进制。字段可以放在文件之前或之后；HMAC 算法和旧版相同，没有新增时间窗口规则。上层 Platform 继续负责用户权限、限流和配额。

成功响应：

```json
{
  "code": 0,
  "data": {
    "url": "https://upload.example.com/tmp/...",
    "mimeType": "image/png",
    "size": 12345,
    "expireAt": "2026-10-11T12:00:00Z"
  }
}
```

相同内容剩余有效期至少 10 分钟时复用旧响应，不根据本次 expires 续期。内容 key 固定使用纯 JS XXH32（seed=0），格式为 `8位小写十六进制哈希-字节数`。哈希与大小作为完整去重依据，不增加同大小碰撞处理。URL 签名始终使用原 Go 版的 BLAKE2b-256，与内容算法独立。旧 Go 存量文件不迁移，旧 CF SHA-256 URL 直接废弃。

服务端／原生客户端可在同一个 upload 请求中添加 X-UploadBroker-Hash 和 X-UploadBroker-Size：已有对象可复用时，读取文件前直接返回 URL；未命中继续上传并核对声明。启用该路径要求实际使用 HTTP/2 或 HTTP/3，鉴权、TTL 也须提前提供。未传新 Header 的调用方式保持兼容。详见 [Header 快速查重接入文档](docs/fast-upload.md)。

支持 PNG/JPEG/WebP、ID3 MP3、WAV、MP4/WebM、PDF、ZIP/7z/RAR，以及原项目文本/源码白名单。按真实文件头检测，不相信上传声明的 Content-Type。M4A/AAC 原项目虽列入配置名单，其实际魔数实现未支持，当前不以扩展名放行。HTML/SVG/XML 内容不开放。

错误码保持原版：40001 缺少文件/表单错误，40002 空文件，40003 不支持类型，40004 超限，40005 TTL 错误，40006 类型不匹配，40401 URL 错误，40402 不存在/过期，40500 方法错误，50000 内部/旧式 HMAC 错误，50001 存储错误。

## 配置

全部配置（包括密钥）统一位于 `deploy/wrangler.jsonc`，不使用 Workers Secrets。该文件已被 `.gitignore` 忽略；仓库提供 `wrangler.example.jsonc` 模板。变量及 R2 binding `bucket` 均为小写，数字、布尔值、盐数组使用原生 JSON 类型。构建和自动测试使用模板配置。

| 变量 | 默认 | 说明 |
|---|---|---|
| base_url | http://localhost:8787 | 部署时改为对外 HTTPS 域名 |
| url_prefix | tmp | 签名 URL 路径前缀 |
| default_ttl_hours | 24 | 1～24 小时 |
| limit_image_mib | 50 | 图片上限，MiB |
| limit_audio_mib | 5 | 音频上限，MiB |
| limit_video_mib | 10 | 视频上限，MiB |
| limit_document_mib | 5 | 文档上限，MiB |
| limit_archive_mib | 30 | 压缩包上限，MiB |
| cors | true | false 关闭跨域响应 |
| build_time | dev/deploy 启动时自动生成 | 注入 UTC 时间戳，health.time 和部署验收使用 |
| url_blake2b_salts | 模板占位符 | 原生数组，1～2 个盐；部署前替换为随机密钥 |
| hmac_secret | 空 | 留空允许匿名上传；由 Platform 持有 |
| content_hash | xxhash32 | 固定内容算法，可省略；其他值拒绝启动 |

单类限制只接受 1～90 MiB 的整数（1 MiB = 1,048,576 字节），请求总上限为最大分类限制 + 1 MiB。原签名允许重放，HMAC 密钥应由 Platform 持有，不嵌入浏览器代码。

## 部署

1. 登录 Cloudflare 并创建本项目专用的 **Standard、私有** bucket：

```powershell
npx wrangler login
npx wrangler r2 bucket create uploadbroker-cf
```

2. 在 deploy/wrangler.jsonc 设置真实 account_id、bucket_name 和 base_url，配置所需域名路由。不要启用 bucket 的公开 r2.dev 或公开自定义域名，否则会绕过 Worker 的签名和 TTL 检查。

3. 在 `deploy/wrangler.jsonc` 中设置 `vars.url_blake2b_salts` 和 `vars.hmac_secret`。第一个盐签发新 URL，第二个可在轮换时接受旧 URL。密钥以明文配置变量部署，持有配置访问权限的人可以读取。

4. 配置生命周期兜底。以下规则仅用于本项目 bucket；逐项添加，保留已有规则：

```powershell
npx wrangler r2 bucket lifecycle add uploadbroker-cf expired-objects "objects/" --expire-days 2
npx wrangler r2 bucket lifecycle add uploadbroker-cf expired-index "index/" --expire-days 2
npx wrangler r2 bucket lifecycle add uploadbroker-cf abandoned-staging "staging/" --expire-days 1 --abort-multipart-days 1
```

这些前缀由本项目 src/storage.js 定义，不是 R2 强制的存储规范，也不需要提前创建目录。R2 是平坦的对象键空间，控制台只是把含 `/` 的键按前缀显示成目录；生命周期同样按键前缀匹配，必须使用正斜杠 `/`。[官方说明](https://developers.cloudflare.com/r2/objects/)

| 对象键前缀 | 本项目用途 | 兜底规则 |
|---|---|---|
| objects/ | 校验成功后的正式文件版本 | 写入两天后删除，留足一天业务 TTL 的余量 |
| index/ | 去重索引，指向当前正式文件版本 | 两天后删除，避免过早清除有效索引 |
| staging/ | 旧版本暂存对象，保留兼容清理 | 一天后删除，一天后中止未完成分段 |

生命周期不是 URL 有效期：业务 TTL 由 Worker 即时检查，Cron 做较快的物理清理，生命周期处理强制终止或异常残留。修改这些键前缀需要同步迁移代码、已有对象和生命周期规则；部署检查已复用代码中的前缀常量。

新版本大文件直接分段上传到 objects/uploads/，不再复制 staging 对象。应保留 R2 默认的未完成 multipart 七天中止规则，也可另加覆盖 objects/ 的较短中止规则；正常请求会主动中止未发布分段。本次升级无需修改已有删除期限。

每 10 分钟的 Cron 精细删除过期文件；生命周期处理索引和异常残留。最大业务 TTL 为一天，索引/文件兜底保留两天。生命周期物理删除可能延迟，访问到期由 Worker 即时判断。

5. 检查配置、测试，然后发布：

```powershell
npm run deploy:check
npm test
npm run deploy -- --dry-run
npm run deploy
```

## 50 MB 与免费 CPU 额度

50 MiB 没有超过 Cloudflare Free/Pro 账户 100 MB 请求体上限。上传采用流式解析 + 增量 XXH32，以 5 MiB 为一段，最多同时处理两个分段，不整包读入 Worker 内存。Header 快速命中时不会读取文件或执行分段上传。

但 **低请求量不等于单请求 CPU 足够**：Workers Free 每次调用只有 10 ms CPU。XXH32、multipart 解析、复制等仍耗 CPU，不能保证任意 50 MB 未命中上传在 Free 稳定成功。本地 workerd 测试不执行线上套餐计费限额。

部署后运行烟雾验证，并在 Cloudflare Workers Metrics / invocation logs 检查 CPU time、错误和上传成功率：

```powershell
npm run smoke -- --base-url https://upload.example.com --size-mib 50
# 使用实际图片验证：
npm run smoke -- --base-url https://upload.example.com --file C:\images\large.png
```

脚本从本地 `deploy/wrangler.jsonc` 读取 hmac_secret，可用 `--config 路径` 指定配置。脚本检查上传、重复上传完整元数据、两次流式下载 SHA-256 和 health，输出下载头部耗时、总耗时及缓存状态。缓存为尽力服务，不强制要求第二次命中。生成测试数据使用有效小 PNG 后追加填充，测试文件传输和头部识别，不代表图片解码测试。输出的 wall time 不是 Worker CPU 时间。

如果 Free 出现 CPU 限额错误，稳定支持 50 MB 的建议是 Workers Paid，并在 deploy/wrangler.jsonc 添加 `"limits": { "cpu_ms": 1000 }`。只在 Paid 使用此配置；不把业务建立在 Free 的偶发超限宽限上。严格要求免费和 50 MB 稳定上传时，需要另行引入客户端分片/直传协议。

免费用量在账户内共享。本实现已取消上传后的整文件复制：不超过 5 MiB 的首次上传只写一次文件，大文件直接完成分段上传。大文件重复上传仍会产生分段写入，查重后主动中止。按每天合计 50 张、24 小时 TTL 的规模通常很小，用户数量本身不消耗额度。

下载通过 Workers Cache API 缓存；命中后省去 R2 索引和文件读取，每次仍验证签名与有效期。响应头 X-UploadBroker-Cache 为 HIT/MISS/BYPASS，浏览器可通过 CORS 读取。缓存键按部署时间隔离，忽略用户查询参数；缓存写入与客户端读取均有背压，写入失败不阻断下载。私有 R2 binding 本身不会自动使用 CDN，详见 [设计说明](docs/design.md#下载边缘缓存)。

官方资料：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[R2 pricing](https://developers.cloudflare.com/r2/pricing/)、[R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

## 哈希基准

`npm run bench` 对 1/10/50 MiB 数据比较 SHA-256 和 XXH32 的独立计算与流式哈希，完整 R2 上传只测固定的 XXH32。历史双算法结果见 [docs/performance.md](docs/performance.md)，不代表当前算法仍可切换。基准 Worker 的整包缓存仅用于隔离计算测量，生产上传保持流式处理。

## 验证范围

自动测试覆盖固定 XXH32 的 50 MiB 上传、下载完整性及超限拒绝，以及 Header 命中／未命中、提前鉴权、协议限制、声明不符、真实本地 HTTP/2 提前响应和旧 SHA-256 URL 拒绝。也覆盖缓存、背压、分段直写、并发去重及旧 XXH32 对象布局。Header 功能尚未完成部署后的真实 Cloudflare 验收。

MIT，沿用原项目版权声明。

## 部署目录与流程

```text
wrangler.example.jsonc    # 根目录的可提交配置模板
deploy/
  wrangler.jsonc          # 实际配置和密钥，Git 忽略
  dist/                   # 构建产物，Git 忽略
  reports/                # 发布/回退状态和版本信息，Git 忽略
scripts/
  deploy.mjs              # 账户检查、构建、发布、业务验收
  rollback.mjs            # 指定版本的受控回退
```

`npm run config:init` 从根模板生成 deploy/wrangler.jsonc，并自动调整 main/schema 相对路径，已有实际配置不会覆盖。手动复制时需改为 ../src/worker.js 和 ../node_modules/wrangler/config-schema.json。`npm run build` 使用根模板生成 deploy/dist，不发布，也不需要生产密钥。

模板和实际配置均已列出顶层 `account_id` 占位字段。将它填写为 Cloudflare 控制台 Workers & Pages 页面显示的 Account ID（32 位十六进制，不是 Zone ID），不要放进 vars。获取方法见 [官方说明](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)。生产配置还需设置 HTTPS base_url 和随机 URL 密钥。自定义域名示例：

```jsonc
"account_id": "你的32位账户ID",
"routes": [{ "pattern": "upload.你的域名", "custom_domain": true }]
```

也支持普通 Worker routes 和 workers.dev。`npm run deploy:check` 使用 Wrangler 已有登录凭据（不输出或保存账户 token），通过 Cloudflare GET API 检查：bucket 存在、有效的生命周期、真实域名挂载或路由目标；普通 routes 还核对代理 DNS。缺少凭据、权限或资源均阻止发布，不会静默跳过。

生命周期按前文固定规则验收：objects/index 两天删除、staging 一天删除和一天中止 multipart。禁用规则、缺少前缀覆盖、可能提前删除的重叠规则均不通过。预检只读取资源，不改动 bucket、DNS、路由或生命周期。正式发布时，Wrangler 会按 routes 配置创建自定义域名绑定。

首次使用 Custom Domain：先创建 bucket、生命周期规则，并在 routes 中配置 custom_domain。域名尚未挂载时，预检确认所属 zone 在当前账户且 active、没有其他 Worker 路由拦截，输出 pending_publish，明确尚未上线；Wrangler 正式发布时创建挂载。发布后必须严格检查已启用的真实绑定，再运行时间戳及业务验收。已有冲突、权限或 zone 错误仍阻止发布。普通 routes 和 workers.dev 继续要求既有资源正确；版本回退不允许 pending_publish。资源查询需要 R2、Workers Scripts，以及普通路由所需的 Zone/Workers Routes/DNS 读取权限；认证不足时按错误提示调整权限或重新登录。

```powershell
npm run deploy:check
npm test
npm run deploy -- --dry-run
npm run deploy
# 更严格的 50 MB 真实上传验收：
npm run deploy -- --smoke-size-mib 50
```

--check 只做配置与只读账户检查；--dry-run 在同样检查后构建，不发布。正式部署生成唯一 UTC 时间戳，以 --var 注入 vars.build_time，health.version 从 package.json 读取，仅作兼容原接口的对外标识，无需配置。实际配置文件不被改写。发布前记录当前 deployment 的版本和流量比例，构建并发布本次产物；发布成功后核对 /v1/health 的 time，而不比对 version。随后复用 smoke.mjs 的真实上传、重复上传完整元数据、下载 SHA-256 验收，最后再次核对 build_time。

默认验收 1 MiB，显式参数可改为 1～50 MiB（不能超过配置图片上限）。测试文件使用 PNG 前缀加随机填充，验证业务传输与类型识别，不能证明完整图片解码。验收产生两次上传和两次下载，资源 TTL 为一小时，沿用正常清理策略。验收观察的是当前访问地点，不代表每个边缘节点均已传播完成。

## 发布失败与受控回退

Cloudflare publish 成功即已上线。验收失败记录为 published_quality_failed（已发布但质量不达标），不是未上线；命令返回非零退出码，并保留 deploy/reports 中的 build_time、发布前后版本和失败阶段。若发布命令本身失败，其结果可能不确定，应先查询账户 deployment。

不自动回滚的原因是回退有副作用，需要人工判断：旧版本可能恢复旧 HMAC 密钥、URL 盐和绑定，与现有 R2 数据不兼容。Cloudflare 版本回退不会恢复 R2 数据、生命周期或域名路由。先查看发布报告及版本，再指定目标版本：

```powershell
npx wrangler deployments list --config deploy/wrangler.jsonc --json
npx wrangler versions list --config deploy/wrangler.jsonc
# 只读取目标版本并显示回退计划，不切流量：
npm run deploy:rollback -- --version 目标版本UUID
# 人工核对副作用后明确执行：
npm run deploy:rollback -- --version 目标版本UUID --execute
```

受控回退读取目标版本的 vars 到内存，核对原域名、R2 绑定、build_time 和账户资源。执行前复查当前 deployment 是否变化，再使用 Workers versions deploy 将目标版本切至 100%，随后验证旧 build_time 并运行相同业务 smoke。不会自动重建旧产物，也不把目标版本的密钥写入报告。回退后验收失败同样表示目标版本已上线但质量不达标，不会连锁自动回退。

没有 build_time 的旧版本、不同域名或 R2 绑定，以及无法读取用于验收的 secret bindings，会被脚本拒绝，应在控制台人工审查。目标版本重新上线不等于恢复数据状态；本地配置不会被脚本改写成旧配置，后续发布前需核对配置漂移。

官方依据：[版本与部署](https://developers.cloudflare.com/workers/versions-and-deployments/)、[回滚及资源限制](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)、[Wrangler 认证 token](https://developers.cloudflare.com/changelog/post/2025-12-18-wrangler-auth-token/)、[R2 生命周期 API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/)。

生命周期检查提示已有规则天数不匹配时，编辑原规则即可，不要重复添加。例如 objects/、index/ 已配置一天删除，需要按本项目两天的兜底策略修改为两天；staging/ 保持一天。两天为本项目策略，留出最大一天业务 TTL 的清理余量，并非 R2 要求。

`npm run dev` 每次启动自动注入 UTC build_time，health.time 表示本次开发进程的启动时间，不是线上发布时间；热更新保持这个值，重启后更新。配置文件不被改写，Wrangler 参数仍可通过 `npm run dev -- --port 8787` 传递。
