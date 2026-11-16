# 多端点模型合并与主备切换设计

状态：用户已批准实施（2026-11-15）。按本设计实现管理页与多端点路由，最终行为及验证结果见 README 和执行记录。

## 已确认需求

- 用户运行 magpie v0.1.4267。
- 一个 kunbot 提供商汇总主线和备线已经暴露的模型。
- 主备同名模型合并为一个可选择模型，优先主线，主线失败后尝试备线。
- 主备各自独有的模型均保留，只发送给确实暴露该模型的端点。
- 手动补充部分 proprietary 模型、一个 ID 被脱敏的生图模型和一个隐藏模型，各自可位于不同 Base URL。
- 本次要补充的端点共用同一个 API Key，但插件现有的多账号登录、各账号独立 API Key 和账号地址覆盖能力必须保留。
- 模型的完整 API 前缀可能分别是 https://anthropic.kunbot.art/v1、https://anthropic.kunbot.org/omni/v1 或其他主机下的 /salt/v1；模型身份、端点身份、账号身份不能混为一项。

## 方案选择

采用命名端点注册与模型显式绑定，在同一提供商内部维护每个模型的候选端点。它不要求为每个独立模型重复登录，同时保留 magpie 原有多账号调度。沿用已有 models 配置，并修复其重复合入导致元数据丢失的问题。

## 配置格式

### 日常入口：线路与模型管理页

用户进一步明确，缩短 JSON 仍然要求手填 Options，不能满足易用性要求。日常入口改为插件自己的「线路与模型」页面；下面的 routes、endpoints 等格式是持久化或高级配置，不要求用户手写。

- 通过 package.json 的 magpie.page 注册静态 HTML/JS 页面，使用 magpie 原生 bridge 样式和 options.get()/options.set() 保存本插件配置。
- 线路表单：线路名、完整 Base URL、协议、是否自动发现模型，支持增加、修改和删除。
- 特殊模型表单：真实模型 ID、显示名（可选）、类型、所属线路；使用选择框完成端点绑定，不填写 JSON。
- 公共模型由后台在账号作用域内自动发现和合并；手动表单主要用于隐藏、脱敏或目录未发布的模型。
- 多账号登录和 Key 保管继续使用 magpie 原来的入口，配置页不重复要求输入 Key，也不读取 Key。
- 页面只保存配置；其沙盒不允许直接 fetch 上游。模型发现仍由插件 provider/auth 后端执行，复用当前账号鉴权。
- 保存时校验完整 URL、模型 ID 和线路引用；后台生成统一模型描述并刷新提供方。
- 0.2.0 已实现页面并在 package.files 中包含页面资源。

自审说明：官方插件文档已确认 page 和 options bridge 能力；没有承诺页面能通过 providers:list 读取账号/Key，也没有承诺静态页面可以直接探测上游。

### 推荐的简化入口：按线路分组

后台接受 routes 分组简写：同一个完整 API 前缀写一次，下面列要补充的真实模型 ID。管理页读取它，并统一保存为 routes 线路定义与 models 模型绑定，以便一个手动模型同时选择主备线路。用户日常只使用表单。

```json
{
  "routes": {
    "proprietary": {
      "base": "https://anthropic.kunbot.art/v1",
      "models": ["proprietary-model-a", "proprietary-model-b"]
    },
    "omni": {
      "base": "https://anthropic.kunbot.org/omni/v1",
      "models": ["hidden-model"]
    },
    "salt": {
      "base": "https://anthropic.kunbot.org/salt/v1",
      "models": { "image-model": "image" }
    }
  }
}
```

示例中的模型 ID 和 salt 的生图用途仅用于展示语法，真实类型及主机由用户提供。

- models 数组默认声明文字模型；对象形式可逐个标记 image、vision、audio 等类型，或使用完整模型对象覆盖能力。
- base 保留完整前缀。npm 等公共设置可在线路上设置一次，具体模型可覆盖。
- 插件内部将 routes 转换为统一的端点及模型描述，用户不必同时维护 endpoints 和 models 两份引用表。
- routes 声明的显式地址不受旧账号全局 Request Base URL 覆盖；账号凭据仍按 magpie 当前选中的账号注入。
- 保留当前 models.<key>.base 写法作为兼容和高级覆盖入口。
- routes 在 0.2.0 中已实现；示例中的模型 ID 仍须替换为真实 ID。

### 完整形式：端点与模型显式绑定

以下地址和 ID 均为说明结构的示例值，不是用户真实配置：

```json
{
  "endpoints": {
    "main": {
      "base": "https://main.example/v1",
      "discover": true
    },
    "backup": {
      "base": "https://backup.example/v1",
      "discover": true
    },
    "paid": { "base": "https://paid.example/v1" },
    "image": { "base": "https://image.example/v1" },
    "hidden": { "base": "https://hidden.example/v1" }
  },
  "fallback": ["main", "backup"],
  "models": {
    "manual/proprietary": {
      "endpoint": "paid",
      "id": "actual-proprietary-id",
      "type": "text"
    },
    "manual/image": {
      "endpoint": "image",
      "id": "actual-image-id",
      "type": "image"
    },
    "manual/hidden": {
      "endpoint": "hidden",
      "id": "actual-hidden-id",
      "type": "text"
    }
  }
}
```

- endpoints 的名字是稳定的端点标识，不能从 URL 的第一段路径或模型类型推断。
- base 是完整 API 前缀，可以包含 /v1 或线路路径，转发时保留这个前缀，不重复拼接目录路径。
- discover 为 true 时，在当前 Key 的权限下读取默认的 `<base>/models`，解析 OpenAI 的 `{data:[{id,...}]}` 模型列表。可用 models_url 显式指定列表地址；未设置 discover 的端点不做发现请求。
- 同名的判断依据是相同的上游模型 ID，不按可能重复的显示名合并。
- fallback 指定主备顺序，只在当前模型实际拥有的候选端点中选择。没有列入顺序的独立手动端点不参与主备轮转。
- 手动模型 endpoint 指定一个命名端点；也保留现有 base/base_url/url 字段作为直接固定地址。显式 base 优先于 endpoint 的 base。
- 手动模型也可用 targets 数组指定有序候选，每项为 `{endpoint, id?}` 或 `{base, id?, npm?}`。候选顺序明确表示该模型的主备关系，允许主备使用不同路径或不同上游 ID。没有 targets 时，endpoint/base 仍是单端点声明。
- 每个模型的 id、type、input/output、context、output_limit、reasoning、tool_call、cost、variants 等原有字段继续可用。
- npm 可在端点或模型上指定，模型值优先；默认 @ai-sdk/openai-compatible。若实际接口使用 Anthropic Messages 或 Responses，按接口指定相应的 SDK 包，不根据 proprietary 这个名称猜协议。
- Options 中不保存 API Key，所有请求使用本次被 magpie 选中账号提供的 Key；不同账号的 Key 不互相复用。

## 多账号与完整路径

每次请求按以下层级解析：

1. magpie 根据现有账号 routing 选择账号，插件的 getAuth 取得该账号的 Key。
2. 根据逻辑模型身份取得其可用端点或 targets，不用模型类型或 URL 首段猜测端点。
3. 解析当前账号对该命名端点的完整地址覆盖，得到本次目标 API 前缀。
4. 拼接协议操作路径并注入本次账号的鉴权。

保留原 Request Base URL 字段及其旧目录镜像前缀语义，不将其悄悄改为完整 API 前缀。对于新命名端点，增加可选的 Endpoint Base URLs 登录字段，填写 `endpoint=完整API前缀` 列表，保存为当前账号的 metadata.endpointBaseURLs；它只覆盖明确指定的端点。

新端点模型的地址优先级：

1. models 中直接指定的固定 base，或 targets 中直接指定的固定 base。
2. 当前账号 metadata.endpointBaseURLs 对该命名端点的完整地址覆盖。
3. endpoints 中该端点的默认 base。

旧目录模型继续保留 Request Base URL 的原有行为；新模型已显式绑定端点时，旧的全局地址不能覆盖它。若希望一个模型随账号使用不同地址，应绑定 endpoint，并由各账号覆盖这个 endpoint，而非写一个全局固定 base。

以兼容 OpenAI Chat 的接口为例，三个不同模型可分别发送到：

- proprietary：`https://anthropic.kunbot.art/v1/chat/completions`
- omni：`https://anthropic.kunbot.org/omni/v1/chat/completions`
- salt：`https://anthropic.kunbot.org/salt/v1/chat/completions`（仅以 salt 与 omni 同域为例，实际主机由配置指定）

使用 Anthropic Messages 时追加的是 `/messages`。`/omni/v1`、`/salt/v1` 作为目标 API 前缀的一部分完整保留，不把主线路径附加到备线路径后面，也不产生 `/v1/omni/v1`。

每个账号分别发现和缓存其有权使用的端点模型；缓存按账号凭据与端点身份隔离，不能把一个账号的模型权限或地址结果用于另一个账号。插件只在当前账号的端点候选中切换，跨账号调度仍由 magpie 管理。

## 模型发现与合并

1. includeCatalog 明确控制旧状态站目录。未指定时，有自动发现线路则关闭旧目录，否则保留旧目录与模型键。
2. 主备目录在账号作用域读取；同时保留旧目录时，用其中已知模型的能力补充新列表，并合并相同上游 ID。手动模型不依赖公开目录或余额成功。
3. 主线和备线分别读取和缓存目录，然后按上游模型 ID 取并集，维护每个逻辑模型的端点可用集合。
4. 重名模型只展示一次，按 fallback 顺序采用主端点的描述和能力。仅协议兼容的端点能透明切换；不同协议不能静默混用同一个请求体。
5. 手动模型在统一模型表上应用一次；修改已有模型的地址时保留其其余元数据。
6. 手动独立端点模型不依赖站点 proprietary feed 中是否存在 models，也不因站点余额或权限状态查询失败而消失。实际调用权限由目标上游校验。
7. 真实生图及隐藏模型 ID 由配置提供，不能根据脱敏文本猜测。

## 请求路由

- 使用明确的模型身份与端点候选表选择目标，不再依赖 routeOf 的 URL 首段猜测。
- 已显式指定 base 或 endpoint 的模型，不能被登录时的 Request Base URL 统一覆盖。
- 自动发现模型按 fallback 顺序尝试候选端点；备线独有模型直接走备线，主线独有模型不会发送到备线。
- 同名模型的主备 API 前缀可以分别位于 /omni/v1 和 /salt/v1；仅在候选表表明它们实际服务同一逻辑模型时建立切换关系。
- 上游请求体 model 使用目标端点对应的真实 ID；完整路径由目标 API 前缀与 magpie 选择的协议操作路径组成。
- 只在尚未向客户端返回响应内容时进行主备切换。网络失败、HTTP 408/429/5xx 允许尝试下一个兼容端点；用户取消、参数错误和鉴权拒绝直接返回，不无限重试。
- 每个候选端点最多尝试一次；流开始后发生错误直接报告，不拼接另一条流。
- 转发保留 Request/URL 两种输入形式中的方法、请求体、内容类型和取消信号。

## 故障处理

- 各端点目录查询有单独超时和缓存，不因一个端点失败阻塞其他端点。
- 刷新失败保留该端点最后成功的模型表；有手动模型时，即使发现接口全部失败也可列出这些手动模型。
- 权限和余额查询独立于明确配置的端点模型列表，不制造空专有目录，也不因 models:{} 自动提交 Key 查询专有权限。
- 日志只报告端点名、模型身份和错误原因，不记录 Key 或完整请求正文。

## 验证范围

使用模拟 HTTP 接口与拦截的 fetch 验证：

- 两个目录的并集、重名去重、主备独有模型的地址。
- 主线成功不调用备线；可重试失败切换；取消或流开始后不切换。
- proprietary、image、hidden 三种手动模型分别到达不同端点，使用正确真实 ID 和协议。
- 账号旧的 Request Base URL 不覆盖显式绑定的模型地址。
- /v1、/omni/v1、/salt/v1 分别保留，主备路径不同也正确切换，不重复拼接路径。
- 两个账号分别使用自己的 Key 和 endpointBaseURLs；模型目录缓存、权限和请求地址不交叉。
- 修改已有模型 base 保留上下文、视觉、推理、工具和费用字段。
- 单端点目录故障保留旧表，所有目录故障不影响手动模型。
- fetch(Request) 保留 POST、body、Content-Type 与 signal。
- 没有 endpoints 的旧配置保持可用，空 models 不触发专有鉴权。

真实地址与真实模型 ID 在配置阶段填写，不需要把 Key 放进设计文档或 Options。实现验证默认不发付费模型请求。

## 增量：精简登录（0.2.2，2026-11-16）

用户明确要求只输入 API Key 与 Account name。移除登录方法中的 Request Base URL 和 Endpoint Base URLs 两个提示；继续由 Magpie 自身收集并保管 Key，账号名称仍用原有 email 元数据字段，保留多账号去重与调度。

新账号从管理页的线路、模型后缀或公共目录获取地址。已存账号的 requestBaseURL、baseURL、baseURLs 和 endpointBaseURLs 元数据继续读取，不迁移或清空已有凭据。日常说明统一以管理页配置地址，不再引导新账号填写已移除字段。

验证沿用现有路由回归，并通过 v0.1.4267 原生宿主验证只有一个 Account name 提示、Magpie 仍提供 API Key 字段、两个名称与 Key 可分别保存并在各账号请求中使用。

## 增量：模型路径后缀（0.2.1）

用户已要求共用主机，只修改每个模型的后缀。采用可选 `models.<key>.suffix`：线路 base 为 `https://ant.kunbot.org`、模型 suffix 为 `7sref` 时，API 前缀为 `https://ant.kunbot.org/7sref/v1`，图片生成使用其 `/images/generations`。

- 后缀只允许相对路径段；去掉两端斜杠，拒绝完整 URL、查询串、片段、空路径段与 `.` / `..`。填写 `7sref/v1` 也不会再加一次版本。
- 存在非空后缀时，把线路末尾的 `/v1` 移到后缀之后，其余线路路径保留；后缀留空时完整沿用现有地址，不自动添加版本。
- 先按既有优先级选择固定地址、账号线路覆盖或默认线路，再拼接后缀。模型后缀默认应用于全部主备候选；高级 `targets[].suffix` 可覆盖模型后缀，空字符串表示该候选沿用完整地址。
- 自动发现模型已有候选时，可以只覆盖 suffix；无候选且无明确 base/endpoint 的模型不得静默忽略非空后缀。
- 管理页显示可选后缀和最终 API 前缀预览，保存与重开保留它。已有高级字段与无后缀配置保持兼容。
- 验证图片、聊天与 Messages 的最终地址、主备切换、账号覆盖、空后缀、重复 /v1 和非法后缀；不使用真实付费请求。
