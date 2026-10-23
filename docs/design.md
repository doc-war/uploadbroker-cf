# UploadBroker CF：原项目分析与实现设计

## 原项目事实

分析依据为相邻 `uploadBroker` 项目的 README、设计文档，以及 `internal/api`、`hash`、`mime`、`metadata`、`cleanup`、`storage`、`config` 实现与测试。行为冲突时以代码为准。

上传流程：解析 multipart → 读取完整文件 → 检测前 512 字节 MIME → 检查扩展名和分类大小 → TTL → BLAKE2b-256 → SQLite 查重 → 驱动存文件 → 更新 SQLite → 签发 URL。

读取流程：验证 URL、签名和 URL TTL → SQLite 按 key 查询 → 检查 URL 扩展名 → 按记录的 backend/storage_key 读取文件流。原实现未独立检查记录过期时间；文件依赖每 10 分钟一次清理最终删除。

重要兼容语义：

- `POST /v1/upload`，文件字段 `file`；`expires` 可选，整数 1～24 小时。
- 可选 `sign` 为 `HMAC-SHA256(secret, timestamp)` 的小写十六进制；旧实现没有时间窗口校验，也未把文件绑定到签名。
- URL `/tmp/{expire}/{shard}/{key}/{token}.{ext}`；key 是 64 位十六进制，shard 是前两位。
- URL token 是 `BLAKE2b-256(salt + '/' + UTC时间yyyyMMddHHmmss + '/' + key)` 前 16 位十六进制。
- 最多两个盐，新 URL 使用第一个盐，读取可接受第二个盐。
- 重复内容剩余 TTL >= 600 秒时返回旧 URL/MIME/大小/有效期，不按新请求续期。低于阈值时重新写入并更新有效期。
- 响应 `{code:0,data:{url,mimeType,size,expireAt}}`，时间为 UTC RFC3339。
- 错误体 `{code,msg}`。原代码 `40500` 映射 HTTP 400，HMAC 错误 `50000` 映射 HTTP 500，继续兼容。
- 文本/源码按扩展名白名单保留类型。HTML/SVG/XML 等活跃内容拒绝；未知扩展名仍允许使用检测到的类型。
- MP3 标准库实际识别 ID3，MP4 sniff 识别 mp4 brand；README 中的 AAC/M4A 名单不等于 Go 实际会识别其文件头。CF 实现不凭扩展名扩张二进制白名单。
- 原代码上传鉴权调用 `FormValue` 可能先完整解析表单，再设置 MaxBytesReader；CF 从第一字节计数，不复刻这个漏洞。

## 已执行的实现规划

1. 梳理接口、签名、去重、MIME 和异常语义。
2. 使用 Workers Fetch API 和唯一 R2 binding，移除 Go、SQLite、本地目录、S3 驱动依赖。
3. 实现有背压的 multipart 解析、原生流式内容哈希、5 MiB R2 分段直写。
4. 实现不可变文件版本、R2 条件更新索引、流式读取和过期清理。
5. 用真实 workerd / 本地 R2 模拟完成协议、并发和 50 MiB 测试；提供部署及线上验收步骤。

## 内容哈希决策

2026-10-23 起，生产内容 key 固定使用纯 JS、增量 XXH32，seed=0，格式为 `8位小写十六进制-字节数`。XXH32 使用 Math.imul 与 32 位运算，无 BigInt/WASM 依赖。哈希与大小作为完整去重依据，项目所有者明确接受同大小碰撞风险，不额外增加强哈希或二次比对。

URL token 仍使用原 Go BLAKE2b-256，仅处理很短的字符串；url_blake2b_salts 与内容哈希算法独立。content_hash 可省略或设为 xxhash32，其他值不再接受。旧 CF SHA-256 URL 直接废弃，读取入口在查询缓存与 R2 之前返回 40401；不迁移、不提供兼容读取。

历史本地三轮基准中 XXH32 的 50 MiB 完整上传中位耗时稍低，但不能证明线上 CPU 更稳定。当前固定算法是为统一客户端 Header 查重协议，不是因为已证明它能保证 Free CPU 限额。[历史性能记录](performance.md)

同一个 upload 接口新增 Header 快速路径：先确定协议、鉴权与 TTL，再按 XXH32 + 大小查询；命中返回原元数据，未命中继续流式上传并核对声明。仅支持服务端／原生客户端通过 HTTP/2 或 HTTP/3 使用，具体字段、优先级与响应语义见 [接入文档](fast-upload.md)。

没有整文件 `arrayBuffer()`、`formData()`，不使用无上限 `tee()`。解析器每次处理最多 64 KiB，保留边界尾部；文件头最多 512 字节，R2 上传最多同时处理两个 5 MiB 分段，标量字段最多 4 KiB，头部最多 8 KiB，最多 32 个 part。请求总体上限为最大分类限制 + 1 MiB。默认图片 50 MiB。

这里说明的是应用缓冲上限，不是整个 isolate 在所有并发量下的总内存保证。

## R2 内部结构

```text
objects/{key}/{expireAt}/{uuid}    不超过 5 MiB 的不可变文件版本，含 expireAt 元数据
objects/uploads/{uuid}            大文件直接完成分段上传，含 directUpload 元数据
index/{key}                       JSON 索引，元数据含 expireAt 和 storageKey
staging/{uuid}                    旧版本暂存对象，保留清理兼容
```

接口允许 `expires/sign/timestamp` 放在文件之后，因此不能假设鉴权和 TTL 在文件开始前已知。不超过 5 MiB 的文件先缓冲，校验、查重通过后只写一次文件；重复文件无需写入文件对象。更大的文件直接向 objects/uploads/ 上传分段，最多并行两个分段，校验和查重完成后才 complete 并发布索引。上传后不再读取整个暂存对象并复制为最终对象。没有已发布索引的文件不能通过网关读取。

大文件查重命中后中止已经上传的分段；仍需要接收和哈希完整请求，不能省掉这些分段写入。未命中时，索引使用 `etagMatches` 或 `etagDoesNotMatch:'*'` 条件更新；并发失败方读取赢家，返回同一 URL，并删除自己的未发布版本。最多重试 8 次，冲突仍未解决时返回可重试的存储错误。索引写入响应丢失时先重读确认，避免删除可能已发布的对象；状态无法确认时保留文件，交由后续清理兜底。

读取通过索引定位文件流，同时验证 URL TTL 和记录 TTL。旧 XXH32 对象布局仍兼容；SHA-256 URL 不再接受，旧 Go 文件/SQLite 记录不会迁入本项目。

## 生命周期与并发

Cron 默认每 10 分钟先扫描 index/ 元数据，收集有效及过期文件引用，再扫描 objects/ 删除过期引用、带过期元数据的旧版本，以及超过一小时且无人引用的 directUpload 对象。遇到缺少引用元数据的旧索引或扫描不完整时，跳过孤儿判断，避免误删。继续扫描 staging/ 删除超过一小时的旧残留。正常请求在 finally 中删除未发布文件或中止分段上传。

Cron 不删除索引：R2 无条件删除无法防止清理者在读取旧索引后，误删刚被另一个上传请求刷新过的索引。索引由 R2 的两天生命周期规则清理；覆盖写入会刷新对象年龄，且最大业务 TTL 只有一天。

必须部署 R2 生命周期兜底：`objects/` 两天、`index/` 两天、`staging/` 一天，并将未完成分段上传的一天中止规则加在 staging 前缀。它处理 Worker 被强制终止、Cron 未运行等 finally 无法处理的情况。生命周期删除可能延迟，访问失效依靠网关 TTL，不依赖物理删除时机。

新版本的大文件分段位于 objects/，应保留 R2 默认的未完成 multipart 七天中止规则；也可另外为 objects/ 配置更短的中止期限。旧 staging/ 规则继续保留，不需要为本次升级修改已验收的删除期限。[R2 分段上传说明](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

每个前缀最多扫描 10 页；避免清理任务无界增长。超过这个规模时生命周期仍是兜底，应重新评估扫描策略。health 同样最多 10 页，超出时 activeCount 为 -1。

## 下载边缘缓存

私有 R2 binding 的 get 不自动查询 CDN。本项目使用 Workers Cache API：先验证 URL 签名和有效期，再查询缓存。命中时跳过 R2 索引与文件读取；未命中时核对索引有效期后流式读取 R2，同时在 waitUntil 中填充缓存。

缓存键忽略用户查询参数，按 build_time 隔离部署；有效期取 URL 与记录有效期的较小值。每次命中重新计算 Cache-Control，移除内部有效期头，返回 X-UploadBroker-Cache: HIT/MISS/BYPASS，并通过 CORS 暴露该头。无效签名或过期请求不能读取缓存。文件在有效期内保持不可变；手动删除 R2 对象不会即时撤销已有缓存。

客户端与缓存写入分别使用有背压的流，避免 Response.clone/tee 在慢客户端下无界缓冲。缓存失败不会阻断正常下载。缓存可能被驱逐或未命中，部署验收记录两次完整下载的头部耗时、总耗时及缓存状态，校验两次内容一致，但不强制要求第二次 HIT。[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)

## 明确的兼容差异

| 项目 | Go | CF |
|---|---|---|
| 文件内容 key | BLAKE2b-256 | 固定 XXH32 + 字节数 |
| URL token | BLAKE2b-256，16 hex | 完全相同 |
| 存储 | Local/S3 + SQLite | 一个私有 R2 bucket |
| 图片默认上限 | 3 MiB | 50 MiB |
| health.sqlite | SQLite 状态 | `not applicable (R2 metadata)`，字段保留 |
| health.time | 二进制修改时间 | build_time；未配置为空 |
| 读取过期 | URL TTL + 后台清理 | URL TTL + 记录 TTL |
| 缓存时间 | 固定 3600 秒 | min(3600,剩余TTL)，must-revalidate |
| URL 校验 | 允许多余路径段 | 严格路径段、仅 XXH32 + 大小 key、16 位 token |
| 非法表单/HMAC 双重错误 | 通常优先 HMAC 错误 | 流式解析期间发现的文件错误可先返回 |

## CPU 与验收边界

**50 MiB 未命中请求不能保证落在 Workers Free 的 10 ms CPU 内**。XXH32、multipart 扫描、复制和 R2 调用准备都需要 CPU；低日请求量不会增加单请求预算，网络等待时间也不等于 CPU 时间。Header 命中跳过文件接收、哈希与写入，但仍需鉴权和 R2 索引／对象存在检查。

本地 workerd 成功只证明实现可执行和大文件内容完整，不证明线上 Free 限额。上线后使用 smoke 脚本发送实际图片，观察 Worker invocation 的 CPU、wall time 和错误。若接近上限，使用 Paid 并配置合理 cpu_ms；严格零付费且必须稳定处理 50 MiB 时，需要另行设计客户端分片/直传协议，不能声称仅换哈希就有硬保证。

参考：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[原生 DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

## 配置方式

Wrangler 配置、vars 和 R2 binding bucket 使用小写。数字、布尔值、盐数组保留原生 JSON 类型。密钥与普通配置统一写入本地 deploy/wrangler.jsonc，该文件被 Git 忽略；模板为 wrangler.example.jsonc，不使用 Workers Secrets。

## 部署门禁与版本恢复（2026-10-11）

根目录 wrangler.example.jsonc 作为模板，实际配置仍位于 deploy/wrangler.jsonc。config:init 自动调整相对路径且不覆盖已有配置。正式部署先确认 Cloudflare bucket、生命周期、域名或路由/DNS，再生成并注入 vars.build_time。health 的 time 必须与本次时间戳一致，health.version 读取 package.json，仅作原接口的兼容标识，配置不再提供 version。

发布成功即已上线，随后执行真实上传、去重完整元数据和下载 SHA-256 验收，默认 1 MiB，可指定 50 MiB。验收后再次核对 build_time；失败记作 published_quality_failed。发布报告保存当前及原 deployment 的版本与流量比例，不保存 API token 或旧版本密钥。

不自动回退是因为旧变量、密钥、绑定及数据兼容性会产生副作用，需人工判断。rollback 脚本先显示目标版本计划，--execute 才使用 Workers versions deploy 将目标切至 100%；目标变量仅在内存中用于相同业务验收。R2 数据、路由和生命周期不随 Worker 版本恢复。没有 build_time 的旧版本需人工审查。

首次 Custom Domain 的真实绑定由 Wrangler 发布创建；预检先验证账户 zone 和冲突，并报告 pending_publish。发布后验收与回退必须确认实际绑定已启用。这样避免“先要求部署副作用存在才能部署”的循环依赖，也不将尚未上线的域名伪装成已通过真实路由验收。
