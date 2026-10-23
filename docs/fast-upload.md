# 同一 upload 接口的 Header 快速查重

`POST /v1/upload` 保持 multipart 上传方式，不新增查重接口。服务端／原生客户端可选择通过 Header 预先声明文件的 XXH32 和大小；如果已有可复用对象，Worker 在读取文件前直接返回原有成功响应。

本功能用于缩短重复文件的响应时间，不承诺消除已经发送或被代理缓冲的上传流量。

## 固定内容算法

- 算法：XXH32，seed 为 0；不是 XXH64、XXH3，也不使用 BLAKE2b 或 SHA-256。
- 输入：文件的原始字节，不包含文件名、multipart 边界、Base64 或其他编码包装。
- 哈希：8 位小写十六进制，不足补前导零，不带 0x。
- 大小：文件原始字节数，以十进制正整数表示，不含 multipart 开销，不带前导零。
- 内部 key：`{hash}-{size}`，例如 `12ab34cd-15728640`。

XXH32 + 大小作为完整去重依据，不额外计算强哈希或检查同大小碰撞。该取舍已由项目所有者接受。URL token 继续使用 BLAKE2b；可选 HMAC 鉴权仍为 HMAC-SHA256，与内容算法独立。

生产内容算法固定为 xxhash32。content_hash 可省略，显式配置时只能是 xxhash32。旧 SHA-256 key 的 URL 直接返回 40401，即使边缘缓存仍存在，也不会读取；旧数据不迁移，交给原清理与生命周期规则回收。此前已经被客户端缓存的副本不会被远程主动抹除。

## Header 定义

| Header | 用途 |
| --- | --- |
| X-UploadBroker-Hash | 文件 XXH32，必须与 Size 成对提供；出现即启用快速路径 |
| X-UploadBroker-Size | 文件原始字节数 |
| X-UploadBroker-Expires | 可选，1～24 小时，未提供时使用服务器默认值 |
| X-UploadBroker-Timestamp | 启用 hmac_secret 时须提前提供 |
| X-UploadBroker-Sign | 启用 hmac_secret 时须提前提供，仍为 HMAC-SHA256(secret,timestamp) 的小写十六进制 |

Header 优先于同名 URL 查询参数，查询参数优先于 multipart 字段。快速路径要求鉴权和 TTL 在读取文件前确定：可以使用上述 Header 或既有查询参数，不能依赖位于文件前后任意位置的表单字段。

特别注意：启用快速路径后，不从 multipart 读取 expires；应改传 X-UploadBroker-Expires，或通过查询参数 expires 指定。两处均未指定则固定使用默认 TTL，命中和未命中的行为一致。后置 sign/timestamp 也不能补足提前鉴权。

不传 Hash/Size 时完全走原上传流程，仍支持 HTTP/1 和后置表单鉴权、TTL。新鉴权与 Expires Header 也可用于普通上传。新 Header 不加入浏览器 CORS 允许名单；本功能不支持网页前端直接调用。客户端类型声明不是身份认证，鉴权继续由上层 Platform 与 hmac_secret 负责。

## 协议要求

启用 Hash/Size 时，客户端到 Cloudflare 必须实际协商 HTTP/2 或 HTTP/3，且调用库应支持在发送请求体期间读取响应。不支持 HTTP/1；协议元数据缺失时也会拒绝，返回 HTTP 400、code 40001。判定依据是 Cloudflare 的 request.cf.httpProtocol，不相信用户提供的协议 Header。

普通本地 Wrangler dev 的 HTTP/1 监听不适合验收该功能。单元测试注入平台协议元数据，另有真实本地 HTTP/2 客户端测试；不能把注入元数据等同于已验证生产 Cloudflare 连接。

HTTP/2 允许服务端在完整请求体收到前返回响应：[RFC 9113 §8.1](https://www.rfc-editor.org/rfc/rfc9113.html#section-8.1)。客户端收到完整成功响应后，可以停止发送剩余文件；不要在成功响应读取完成前主动断开连接，避免丢失响应。

## 处理与响应

1. 检查 Header、文件声明大小、HTTP 协议、提前鉴权和 TTL。
2. 查询 `index/{hash}-{size}`，检查记录大小、当前分类上限、底层对象存在及剩余 TTL 至少 600 秒。
3. 命中：不读取文件、不创建 multipart、不写入文件或索引，直接返回原元数据和 URL，不延长有效期。
4. 未命中、对象缺失或剩余 TTL 不足：继续原来的完整上传流程，Worker 自行计算 XXH32 和大小，核对声明后提交索引。

成功 JSON 结构不变，额外返回 `X-UploadBroker-Dedup`：

- `HIT`：本次通过 Header 预查重提前返回，未校验本次请求体的类型、文件名或内容。
- `MISS`：本次已继续接收并校验上传；也可能在最终并发查重时复用了其他请求的结果。
- 未启用新 Header 时不返回该响应头。

快速路径成功响应为 Cache-Control: no-store。Hash/Size 格式不正确或实际内容不符返回 40001；声明超过总分类上限或记录超过当前分类限制返回 40004；TTL 不正确返回 40005；鉴权错误保持 50000，存储查询失败为 50001。内容不符时，已经发送的 R2 分段会中止，不发布索引。

快速命中代表凭声明引用已有资源，不证明客户端持有原文件，也不重新识别本次文件。匿名上传模式同样允许快速引用全局已有对象；需要访问隔离时由上层 Platform 控制，本次不增加用户／租户存储模型。

## 请求示例

先对文件计算 XXH32 和大小，再发送**同一个**上传请求。以下示例要求 curl 编译时支持 HTTP/2；替换占位哈希、大小、文件与鉴权值：

```powershell
curl.exe --http2 "https://upload.example.com/v1/upload" `
  -H "X-UploadBroker-Hash: 12ab34cd" `
  -H "X-UploadBroker-Size: 15728640" `
  -H "X-UploadBroker-Expires: 2" `
  -H "X-UploadBroker-Timestamp: 你的时间戳" `
  -H "X-UploadBroker-Sign: 对应的HMAC签名" `
  -F "file=@C:\images\large.png" `
  -D -
```

--http2 是协商请求，不保证成功使用 HTTP/2；应检查实际协议，协商回退到 HTTP/1 时 Worker 会拒绝。hmac_secret 留空时省略 Timestamp/Sign。

## 验收重点

先用普通上传保存一份十几 MiB 的图片，再通过 Header 快速路径限速重复上传，记录实际协议、响应到达时刻、已经提交的文件字节数和 Dedup 响应头。应在文件尚未全部发送完时拿到完整成功响应，且 data 与首次上传完全相同。

未命中也要上传并校验成功；故意声明错误哈希或大小应被拒绝。完整上传的 wall time、客户端计算哈希的时间与 Worker CPU 分别记录。新代码需用户部署后才能完成真实 Cloudflare 验收。
