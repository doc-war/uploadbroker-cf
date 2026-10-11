# 本地验证记录

## 边缘缓存与上传直写（2026-10-11）

释放系统内存后重跑 `npm test`：Wrangler dry-run 构建成功，64 项测试全部通过，无失败或跳过。

- SHA-256、XXH32 均通过 50 MiB 流式上传下载与 50 MiB + 1 字节拒绝；本地上传下载耗时分别为 7952 ms、7571 ms，不代表线上 CPU 或网络表现。
- 原生 Cache API 第二次下载命中；单元测试确认命中跳过全部 R2 读取，签名、盐轮换、URL/记录过期和部署时间隔离有效。
- 慢客户端下缓存填充有背压；缓存读取、写入及中途停止故障不截断正常下载。
- 大文件直接完成 multipart，无整文件读取/复制；不超过 5 MiB 的文件在查重前不写文件对象。
- 覆盖双分段并行上限、并发索引更新、写入响应丢失、异常残留清理与旧对象/索引读取兼容。
- 部署 smoke 完成两次上传及两次完整下载，保留内容哈希和 build_time 校验，并报告下载缓存状态、头部耗时及总耗时。

本地验证阶段未发布生产。随后用户自行部署成功，已完成线上对比：两版 1/10 MB 完整链路通过，CF 49 MB 上传、去重及下载通过，缓存 HIT 实测有效。Go 49 MB 返回 20 MiB 上限拒绝，不做该体积性能比较。详见 [优化后线上记录](live-network-after-optimization-2026-10-11.md)。

## dev 启动时间注入（2026-10-11）

`npm run dev` 改为 scripts/dev.mjs，每次启动生成 UTC build_time，通过 Wrangler --var 注入，不改写实际配置。CLI 参数继续透传；热更新保留本次启动时间，重启生成新时间。脚本语法检查通过，Wrangler 确认接收 build_time，独立端口曾启动至 Ready。随后本地环境出现 V8/Workerd 及 PowerShell CoreCLR 内存初始化异常，未完成最终 HTTP health 时间戳断言；本次验证服务已停止。

日期：2026-10-10（Asia/Shanghai）。

## 已通过

- `npm test`：Worker dry-run 构建成功，16 个测试全部通过。
- workerd + 本地 R2：50 MiB 流式上传和下载，下载 SHA-256 与资源内容 key 一致。
- 50 MiB + 1 字节拒绝；暂存无已发布残留。
- multipart 边界拆分、文件内容中的伪边界、头部超限和截断。
- R2 分段缓冲为 5 MiB；存储失败时执行 abort。
- 表单文件优先、签名字段后置、错误码和文本类型兼容。
- 5 个并发重复上传返回同一 URL，最终只保留一个文件版本。
- 临近到期续期、丢失底层文件后的修复、过期访问拒绝和旧版本清理。
- 原 Go 仓库 `git status --short` 无输出，未修改原项目。
- `node --check scripts/smoke.mjs`、`npm ls --depth=0` 通过。

## 本地 HTTP 验证

运行 `npm run dev -- --port 8787`，然后 `npm run smoke -- --base-url http://localhost:8787 --size-mib 50`。

最终一次使用新随机填充内容的结果：

```json
{
  "status": "passed",
  "bytes": 52428800,
  "firstUploadWallMs": 5602,
  "duplicateUploadWallMs": 2900,
  "downloadSHA256": "b2ee46b376e01b12a398f9c9950b89b9f568683ef40a26e36f092b296649d2e5",
  "health": "ok"
}
```

脚本每次生成一块新的随机填充并在本次运行中复用，保证首次上传不是已有内容的查重命中，同时能验证本次重复上传。文件使用小 PNG 前缀加填充，沿用原项目头部识别语义，验证传输而非完整图片解码。

首次 HTTP 调试曾出现 Wrangler 本地 ProxyWorker 的 `Network connection lost`，当时业务 handler 日志为 200。后续 1 MiB、已有 50 MiB 内容，以及新的随机 50 MiB 内容验证成功；没有把这个瞬时连接错误当作已定位、已修复的业务缺陷。脚本已经支持报告非 JSON HTTP 错误，避免只显示 JSON 解析异常。

本地开发服务已停止。上述耗时是 wall time，包含本地磁盘/R2 模拟和 HTTP 往返，不能推导线上延迟或 CPU time。

## 尚待部署后验证

真实 Cloudflare Free 单请求 10 ms CPU、跨地域网络、慢上传中断行为、真实 bucket 生命周期、实际费用。项目没有创建远程 bucket、设置线上密钥或部署 Worker。

上线操作和 CPU 限额处理方式见 README。生命周期规则必须配置，防止运行时强制中止产生的残留。

## 配置与 XXH32 更新验证

- 两种内容算法共 29 项测试全部通过，包括各自的 50 MiB 上传、下载完整性、并发去重及清理。
- 纯 JS XXH32 与独立 xxhash-wasm 实现核对多个种子、长度、偏移和分块；WASM 仅用于测试，不进入生产 Worker。
- 不同大小记录不会被复用；XXH32 key 包含文件大小。
- 单文件小写配置，原生数字/布尔值/数组；烟雾脚本从 JSONC 读取上传密钥。
- 三轮 1/10/50 MiB 基准完成，方法及结果见 [performance.md](performance.md)。本地 wall time 和采样 profiler 数据均不能等同于 Cloudflare 计费 CPU。

最终复跑曾在 Miniflare dispatchFetch 代理的 50 MiB 下载上遇到 ECONNRESET，两种算法均出现。测试入口已改为直接请求 mf.ready 的本地 HTTP 监听地址，关闭连接复用；没有添加重试或修改生产逻辑。配置烟雾测试另通过 1 MiB HTTP 上传、去重、下载和 health。

## deploy 目录迁移验证

- 配置和密钥迁入 deploy/wrangler.jsonc，模板为 wrangler.example.jsonc；main/schema 路径已同步。
- npm test：模板 dry-run 构建至 deploy/dist，32 项测试全部通过，包含两种算法各自的 50 MiB HTTP 上传和下载。
- 新增生产配置检查测试；当前 localhost 配置被 npm run deploy:check 按预期拒绝。
- 已生成 worker.js 的 --no-bundle 发布命令通过 dry-run 验证，没有发布线上版本。
- scripts/deploy.mjs 语法检查通过。发布后健康检查仅实现，尚未在真实账户验证。

## 部署验收增强（2026-10-11）

- 根目录模板构建及完整测试通过，共 44 项；包含两种算法各自的 smoke 真实 HTTP 上传、重复元数据、下载及 build_time 校验。
- 部署时间戳单调唯一；同静态 version 的旧时间戳拒绝验收。
- 发布成功后业务失败的状态为 published_quality_failed；发布调用失败不运行验收，结果不确定时提示检查账户。
- 账户 GET API 检查通过受控响应测试：bucket、启用的生命周期、域名挂载；禁用规则、缺少 multipart 中止、提前删除、错误路由和权限失败均被拒绝。
- 回退读取目标版本的变量到内存，验证 R2/域名与 build_time；不同绑定及旧式无时间戳版本被拒绝。
- 没有调用真实账户 API、发布或回退线上版本。远程资源检查和版本切流尚待已配置账户验证；本地测试不替代真实 Cloudflare 验收。

## 配置入口与键前缀说明修正（2026-10-11）

- 模板及现有实际配置补齐顶层 account_id 占位字段，不猜测账户，不覆盖其他用户配置。
- 删除 vars.version；health.version 从 package.json 获取，部署门禁仍只依赖 build_time。
- 账户生命周期校验复用 storage.js 中的 OBJECTS/INDEX/STAGING 常量。
- README 明确 R2 平坦对象键空间、正斜杠前缀、业务 TTL/Cron/生命周期各自职责。

## 实际生命周期诊断（2026-10-11）

只读查询 uploadbroker bucket：objects/ 的“过期对象”与 index/ 的 expired-index 均设为一天删除，staging/ 一天删除及中止 multipart 已符合策略。当前门禁要求 objects/index 两天，所以拒绝验收；未修改远程规则。

错误提示已区分已有保留时间不匹配，并建议编辑原规则；兼容 Cloudflare 全桶规则省略 prefix 的返回形式。11 项部署流程相关测试通过。真实 deploy:check 按预期报告现有规则一天，与两天策略不匹配。

## 首次自定义域名部署流程修正（2026-10-11）

- 实际配置补齐 Custom Domain routes。发布前缺少绑定时核对 active zone、账户归属和路由冲突，明确返回 pending_publish，而不是声称域名已上线。
- 发布后及版本回退必须严格校验真实已启用绑定，不允许 pending 状态通过。
- 12 项部署流程测试通过，包含首次部署可准备、发布后缺少绑定拒绝、zone 缺失与其他 Worker 拦截拒绝。
- 真实 npm run deploy:check 已通过；实际生产配置的 --dry-run 构建与发布前版本记录已通过。
- 本次只修改本地 routes 配置、查询账户并 dry-run；未发布 Worker，未创建远程域名绑定。上次明确修改的生命周期规则已是 objects/index 两天。
