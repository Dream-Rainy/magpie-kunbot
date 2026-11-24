# magpie-kunbot

kunbot 的 [Magpie](https://usemagpie.ai/docs/zh/plugins) 提供商插件。在一个 `kunbot` 提供商中管理不同地址的模型，支持主备切换、多账号和请求诊断。

当前插件版本：**0.4.1**。接口协议在模型卡片中设置，同一 endpoint 可供不同协议的模型共用。

## 功能

- 使用表单管理线路和模型，无需日常手写 Options JSON。
- 支持 Chat、Responses、Anthropic Messages、Gemini 原生 API 和 System One 决策 API。
- 每个手动模型独立选择调用协议，并将其用于该模型的主备线路。
- 合并多条线路暴露的模型；同名且协议一致时优先主线，失败后尝试备线。
- 为专有、隐藏、脱敏生图等目录外模型指定真实 ID、类型和独立地址。
- 多个模型共用一个主机，分别填写模型路径后缀。
- 复用 Magpie 原生多账号登录；每个账号使用自己的 API Key。
- 在独立测试页预览、编辑和发送 JSON，查看各候选的请求体、响应及错误。
- 手动导出、导入完整插件配置，方便备份及跨设备迁移。
- 可保留 kunbot 公共目录，并通过 `magpie quota` 查询 Pt 余额。

## 安装与升级

### 本地目录或压缩包

压缩包先解压，再添加包含 `package.json` 的目录。Magpie v0.1.4267 不能直接把 `.tgz` 当作本地插件入口。

```sh
magpie plugin add /绝对路径/magpie-kunbot
```

若同时安装了 GitHub 版和本地版，请在插件页面选择由当前版本提供 `kunbot`，或运行：

```sh
magpie plugin use /绝对路径/magpie-kunbot kunbot
```

升级本地版本时，将新文件覆盖到**原插件目录**，保持安装路径不变，再重启 Magpie。账号和插件选项由 Magpie 保存，无需重新填写。仅修改源码不会自动触发宿主重载。

### GitHub

```sh
magpie plugin add github:wsyzxjn/magpie-kunbot
```

请确认实际安装版本包含本文所述的管理页与测试功能。

## 登录与开始使用

1. 在 Magpie 插件页面找到 `kunbot`，点击登录；也可运行 `magpie plugin login kunbot`。
2. 填写 **Account name** 和 **API Key**。名称可选；多个账号建议使用不同名称，例如 `personal`、`work`。登录不再询问地址。
3. 打开侧边栏的 **kunbot · 线路与模型**。
4. 添加线路或手动模型，在模型卡片选择 **接口协议**，点击 **保存配置**。
5. 到 `kunbot` 提供商中选择模型。生图模型还需在 Magpie 的图像模型设置中选用。

正常请求使用 Magpie 选中的账号；线路与模型配置供这些账号共用。账号调度继续由 Magpie 管理，例如：

```sh
magpie provider set kunbot routing=rotate
```

## 配置线路与模型

### 共用主机，按模型填写后缀

下面使用占位模型 `your-image-model-id` 和示例后缀 `image-route` 演示，使用时替换为实际配置：

| 位置 | 填写内容 |
| --- | --- |
| 线路 → 完整 Base URL | `https://ant.kunbot.org` |
| 模型 → 接口协议 | OpenAI Chat |
| 模型 → 真实模型 ID | `your-image-model-id` |
| 模型 → 模型类型 | 图像生成 |
| 模型 → 主线路 | 选择上面的线路 |
| 模型 → 模型路径后缀 | `image-route` |

页面预览的 API 前缀为：

```text
https://ant.kunbot.org/image-route/v1
```

实际生图请求为：

```text
https://ant.kunbot.org/image-route/v1/images/generations
```

其他模型可复用这条线路，分别填写真实 ID、类型及后缀，例如 `omni`、`salt`。模型选择了备用线路时，同一后缀也会应用于备线。

后缀规则：

- `image-route`、`/image-route/`、`image-route/v1` 均生成 `…/image-route/v1`。
- 线路末尾已有 `/v1` 时，将版本放到后缀之后；其余线路路径保留。
- Gemini 模型的后缀默认补齐 `/v1beta`，线路末尾的 `/v1beta` 或 `/v1` 移到后缀之后；后缀已包含这两种版本之一时不再追加。
- 后缀留空时，完整沿用线路地址，不自动添加 `/v1`。
- 后缀接受字母、数字、`-._~` 和 `/` 分隔；不接受完整网址、查询参数、空路径段或 `.` / `..` 路径段。

### 使用完整独立地址

不同主机或不同协议可分别建立线路，例如：

| 线路示例 | 完整 API Base URL |
| --- | --- |
| 专有 | `https://anthropic.kunbot.art/v1` |
| omni | `https://anthropic.kunbot.org/omni/v1` |

模型选择对应线路，后缀留空即可。在模型卡片的 **接口协议** 中选择 OpenAI Chat、Anthropic Messages、OpenAI Responses、Gemini 原生 API 或 System One 决策 API。不同模型可共用同一 endpoint 并选择不同协议；域名或模型名称不能代替协议设置。

Chat 等协议的图片生成沿用 OpenAI Images 接口；Gemini 模型使用原生 `generateContent`，以 `responseModalities` 请求图像输出。

### Gemini 与 System One

| 模型协议 | `protocol` 值 | 完整 Base URL 示例 | 用途 |
| --- | --- | --- | --- |
| Gemini 原生 API | `gemini` | `https://gateway.example/v1beta` | 原生文字、视觉和图像请求 |
| System One 决策 API | `systemone` | `https://gateway.example/v1` | 路由组的决策分类器 |

上述地址均为占位示例。模型后缀留空时完整沿用地址；共用主机时也可以按模型设置后缀，Gemini 默认补齐 `/v1beta`，System One 补齐 `/v1`。

Gemini 的调用地址为 `<base>/models/<真实ID>:generateContent`，流式请求使用 `:streamGenerateContent?alt=sse`，认证使用当前账号的 `x-goog-api-key`。模型 ID 位于路径中，主备 ID 不同时会分别替换路径，不向原生 JSON 请求体加入 `model` 字段。

System One 请求 `<base>/systemone`，发送 `model`、`questions`、`state`。插件自动声明决策能力，并将选择此协议的模型标记为决策模型，供 Magpie 路由组的分类器选择；这些模型不用于普通对话。登录仍使用原有账号和 API Key。

模型的协议保存为 `models.<key>.protocol`，优先于线路默认值。线路的 **目录地址与线路标识 → 自动发现默认协议** 用于目录鉴权和未覆盖的自动发现模型，不限制手动模型的调用协议。

### 自动发现与公共目录

对支持模型列表接口的主备线路，开启 **自动发现模型**。插件用当前账号 Key 请求：

```text
<线路 Base URL>/models
```

接受标准列表：

```json
{ "data": [{ "id": "model-a" }, { "id": "model-b" }] }
```

自动发现默认协议为 Gemini 时，同时接受原生 `models[]` 列表，读取 `name`、`displayName`、输入和输出限制，按 `nextPageToken` 加载后续页面；原生列表中只支持嵌入等操作的模型不会作为生成模型列出。

需要独立目录地址时，展开 **目录地址与线路标识**，填写模型目录地址。发现仍按线路查询，不会逐个拼接模型后缀；共用裸主机只用于手动模型时，可关闭发现。

**同时保留 kunbot 状态站发布的模型** 控制是否加入原有公共目录。插件读取：

| 接口 | 用途 |
| --- | --- |
| `/configs/pi/models.json` | 模型地址、协议、上下文、费用及推理档位 |
| `/api/openweight` | 从 `Image Generation` 标签和 `Supported Model:` 备注识别生图模型 |
| `/api/proprietary` | 仅当其中确实包含模型列表时，用于自动追加专有模型 |

目录里被问号脱敏的名称无法还原真实 ID，请手动补充。手动模型不依赖公开专有列表或余额查询成功；实际权限由上游校验。插件不按状态站健康检查结果隐藏模型。

每条发现线路单独超时并缓存，刷新失败保留该宿主进程内上次成功的目录。缓存按账号 Key 和完整地址隔离。

### 模型类型

| 类型 | 默认输入 | 默认输出 |
| --- | --- | --- |
| `text`：文字对话 | text | text |
| `vision`：文字 + 看图 | text, image | text |
| `image`：图像生成 | text | image |
| `audio`：语音合成 | text | audio |
| `transcription`：语音转写 | audio | text |
| `video`：视频生成 | text | video |

这些类型声明模型能力，是否支持对应操作仍取决于上游。图生图模型可通过高级选项补充 `"input": ["text", "image"]`。

## 主备切换

自动发现的模型按真实 ID 取并集。同名且协议一致的模型只显示一次，按线路排列顺序尝试；主线独有、备线独有的模型只发给确实提供它的线路。不同协议的同名项不会被直接组成透明主备。

手动模型按自己选择的主线路、备用线路尝试，两条线路均使用该模型选择的调用协议，不按线路的自动发现默认协议筛选。线路仍需实际支持对应协议。两条线路可使用不同的完整路径；高级配置还能为备线指定不同的真实模型 ID。

主动修改模型协议时，会将选择应用于已有全部候选，并保留候选各自的真实 ID、地址与后缀；未修改协议时，已有高级候选设置完整保留。

| 情况 | 插件行为 |
| --- | --- |
| 主线成功 | 直接返回，不请求备线 |
| 网络失败、HTTP 408、429、5xx | 尝试下一条兼容候选，每条最多一次 |
| HTTP 400、401、403、404 等其他错误 | 直接返回，便于定位请求或权限问题 |
| 用户取消 | 停止请求，不切换 |
| 已交付给客户端的流式响应中断 | 报告错误，不拼接另一条流 |

主备线路需使用同一协议。不同协议的请求体结构不同，不能只替换地址来切换。
System One 与普通 Chat 也分别判断，不因底层 SDK 包名相同而混成主备。

## 模型测试与诊断

在配置页保存后，点击 **模型测试 · 查看请求与响应**：

1. 选择已登录账号与模型，无需重新输入 Key。
2. 页面生成对应协议的 JSON 示例，可修改请求体、操作接口与超时。
3. 点击 **预览请求**，查看各候选的最终地址、脱敏请求头及真实请求体。此步骤不发送模型推理请求；载入模型仍可能查询目录。
4. 点击 **发送测试（可能计费）**，查看实际尝试的线路、HTTP 状态、耗时、响应或异常。
5. 可取消测试或复制诊断；账号登录状态变化后，点击 **重新加载账号与模型**。

Chat、Messages、Responses 和 System One 请求体中的 `model` 会替换为所选模型的真实 ID；Gemini 则替换路径中的 ID。备线 ID 不同时，诊断也会显示各自的值。认证头、Cookie、凭据字段及上游回显的当前 Key 会隐藏。

支持范围：

- 支持 Chat、Anthropic Messages、Responses、Gemini、System One、生图和语音合成的 JSON 请求。
- 暂不提供文件上传、图片编辑或语音转写测试。
- 直接请求插件上游，复用模型地址、后缀、账号覆盖及主备逻辑；不经过 Magpie 的 agent 协议转换或账号调度，网络使用宿主的默认代理。
- 默认非流式输出；Gemini 可选择 `streamGenerateContent` 操作，其他对话协议可修改 JSON 的流式设置。
- 超时可选 15–120 秒；请求体和响应读取上限均为 64 KiB。图片 base64 和二进制用摘要表示。
- 结果包含填写的测试内容和脱敏响应，仅在本页保留，不写入插件配置或诊断日志。

**返回配置** 会打开同一本地服务下的配置页，继续通过 Magpie 读取、保存设置，不依赖浏览器历史或回跳 `wails.localhost`。

## 手动导出与导入

在 **kunbot · 线路与模型 → 配置备份** 中操作，适用于跨设备迁移或 Magpie 同步未覆盖插件 Options 的情况。

**导出：**点击 **导出配置**，再点击 **复制 JSON**。可把文本保存为 UTF-8 的 `.json` 文件，或直接复制到另一台设备。备份包含当前表单中已经通过校验的内容，包括尚未保存的修改；导出本身不会保存配置。自动复制不可用时，可用 **全选 JSON** 后按 Ctrl+C（Mac 为 ⌘C）。

**导入：**点击 **导入配置**，粘贴 JSON 或选择文件，再点击 **预览导入**。检查线路数、手动模型数与公共目录开关后，点击 **替换到编辑区**，检查模型设置，最后点击 **保存配置**。

- 导入是完整替换，包括当前未保存的编辑内容；不自动合并。预览、取消或错误输入不会改变编辑区或已保存配置。
- 导出保留线路顺序、发现设置、模型后缀、全部主备候选及各自 ID、模型能力和高级字段；已有分组配置在表单保存时会统一整理为线路和模型绑定。
- 导入仅载入未保存草稿，点击保存才写入 Magpie；可以先导出当前配置再替换。
- 支持插件生成的版本化备份，以及直接复制的原始 Options JSON。文本与文件上限均为 **1 MiB**，无效地址、线路引用、候选协议或不支持的备份格式会显示错误。
- 迁移范围是本插件 Options。账号、API Key、旧账号独立地址覆盖、测试结果、Magpie 的模型启用及图像模型选择仍由目标设备自行管理。

Magpie 的插件沙盒限制普通文件下载，因此导出使用可复制文本；文件导入直接在当前页面读取，不上传到模型端点。

## 高级选项

日常使用管理页即可。以下字段可在 Magpie 插件 **Options** 中编辑；其中不能放 API Key。

下面示例关闭公共目录，使用共用主机、备线和一个独立专有端点：

```json
{
  "includeCatalog": false,
  "routes": {
    "main": { "base": "https://ant.kunbot.org" },
    "backup": { "base": "https://backup.example" },
    "paid": { "base": "https://anthropic.kunbot.art/v1" }
  },
  "fallback": ["main", "backup", "paid"],
  "models": {
    "manual/your-image-model-id": {
      "id": "your-image-model-id",
      "protocol": "chat",
      "type": "image",
      "suffix": "image-route",
      "targets": [{ "endpoint": "main" }, { "endpoint": "backup" }]
    },
    "manual/hidden": {
      "id": "your-hidden-model-id",
      "protocol": "responses",
      "type": "text",
      "endpoint": "main",
      "suffix": "omni"
    },
    "manual/private": {
      "id": "your-private-model-id",
      "protocol": "anthropic",
      "type": "text",
      "endpoint": "paid"
    }
  }
}
```

`backup.example` 和 `your-…-model-id` 是占位值，使用时替换为实际地址及真实 ID。示例展示同一线路关联不同协议的模型，具体可用协议以上游实际支持为准。

### 线路与顶层字段

| 字段 | 说明 |
| --- | --- |
| `routes.<name>.base` | 主机或完整 API 前缀；也接受 `base_url`、`url` |
| `routes.<name>.protocol` | 自动发现默认协议及旧配置默认值；支持五种协议，默认 `chat` |
| `routes.<name>.discover` | 是否用当前账号读取 `<base>/models` |
| `routes.<name>.models_url` | 独立的完整目录 URL |
| `routes.<name>.models` | 分组简写，支持 ID 数组或 ID 到模型设置的映射 |
| `endpoints` | 与 `routes` 相同的高级形式，同名时 `routes` 优先 |
| `fallback` | 自动发现线路的优先顺序；管理页按上下排序保存 |
| `includeCatalog` | 是否加入状态站公共目录；未指定时，有自动发现线路则关闭，否则保留 |
| `discoveryTimeoutMs` | 发现超时，默认 8000 ms，范围 100–30000 ms |
| `diagnosticsPort` | 本地测试服务端口，默认 `37747`；多个 Magpie 实例应使用不同端口 |

### 模型字段

`models` 的键是插件内的模型键，值可以是类型字符串，也可以是对象：

| 字段 | 说明 |
| --- | --- |
| `id` | 上游真实模型 ID；未填时沿用已有模型或从模型键推导 |
| `name` | 显示名称 |
| `type` | `text`、`vision`、`image`、`audio`、`transcription`、`video` |
| `endpoint` | 引用命名线路 |
| `base` / `base_url` / `url` | 单个模型的固定 API 前缀，可替代命名线路 |
| `suffix` | 可选模型路径后缀，留空保留完整地址 |
| `targets` | 有序主备候选数组；候选可设置 `endpoint`、`base`、`id`、`suffix` |
| `protocol` / `npm` | 此模型的调用协议或 AI SDK 包，优先于线路默认值；用于主备候选，候选之间必须兼容 |
| `input` / `output` | 自定义模态数组 |
| `context` / `output_limit` | 上下文长度和输出上限 |
| `reasoning` / `tool_call` | 推理及工具调用能力 |
| `cost` / `variants` / `rate` | 费用、推理档位和倍率 |

`targets[].suffix` 优先于模型的 `suffix`，空字符串表示该候选沿用完整地址。已有目录模型可以只覆盖能力或地址；修改地址会保留未显式覆盖的能力元数据。

### 模型键与调用 ID

在 Magpie 中调用时使用 `kunbot/<模型键>`，不要把这个完整 ID 当作上游真实 ID：

| 来源 | 调用 ID 示例 |
| --- | --- |
| 管理页新增模型 | `kunbot/manual/your-image-model-id` |
| 自动发现且未沿用旧目录键 | `kunbot/<真实ID>` |
| 原有公共目录模型 | `kunbot/<route>/<真实ID>` |

TTS / 转写的模型键最后一段需让 Magpie 识别类型，例如 `tts-voice`、`voice-tts`、`whisper-1` 或 `voice-transcribe`。真实上游 ID 不符合时，使用可识别的键并用 `id` 指向实际值。管理页新增语音模型时会为键添加对应前缀。

## 旧账号与旧配置

已有账号无需重新登录。`models`、`extraModels`、`routes`、`endpoints` 及旧账号地址字段继续读取，管理页保存时保留未编辑的高级字段。

旧手动模型会显示其原有效协议，保存时明确写入模型层。仅覆盖目录能力、未绑定线路的旧条目沿用原协议；选择主线路后即可单独设置协议。

地址选择顺序：

1. 模型或候选显式指定的固定 `base`。
2. 命名线路的旧账号 `endpointBaseURLs` 覆盖（如有），否则使用线路默认地址。
3. 按模型或候选的 `suffix` 拼接地址。
4. 仅对没有显式候选的旧目录模型，应用旧账号的 `requestBaseURL`、`baseURL`、`baseURLs` 前缀覆盖。

旧账号的请求前缀保留原目录路径；命名线路和固定模型地址不受它覆盖。新登录只收集名称和 Key，新地址统一在管理页配置。

## 账号与数据流

- API Key 由 Magpie 保存在当前配置目录的 `plugin-auth.json` 中；不写入模型 Options。
- 正常模型请求使用当前选中账号的 Key，发送到所配置线路或目录提供的模型地址。
- 测试后端从宿主传入的配置目录只读取 kunbot 账号，发送前重新确认账号状态；前端只收到账号名称和标识。
- 测试服务仅监听回环地址，API 使用随机会话令牌。Web 模式经 Magpie 页面服务代理访问；服务端口冲突不影响普通模型请求。
- 余额查询会向固定状态站 `ant.kunbot.org` 的 `/api/proprietary/key` 提交 Key，取得会话后读取 `/api/proprietary/access`，结果通常缓存 30 分钟。
- 当公共专有目录确实包含模型时，模型列表刷新也会查询该 Key 的专有权限；手动模型不依赖这项查询。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 看不到管理页或模型测试入口 | 检查安装版本及当前负责 `kunbot` 的插件，升级后重启 Magpie |
| 共用主机发现不到模型 | 检查它是否提供 `<base>/models`；可填写独立目录 URL，或关闭发现后补充手动模型 |
| 图片模型不出现在图像设置中 | 在本插件中选择“图像生成”，保存后确认该模型在提供商中已启用 |
| 模型出现但调用失败 | 先预览最终地址与请求体，再发送测试，检查 HTTP 状态、真实 ID、协议及权限 |
| 测试服务无法连接 | 检查 `diagnosticsPort` 是否被其他程序或 Magpie 实例占用 |
| 返回配置时仍提示 `wails.localhost` 拒绝连接 | 确认实际加载的是 0.3.1 或更新版本，并重启 Magpie |
| 提供商里的“Add model”没有生成可用端点 | 请在本插件管理页添加模型；提供商模型选择器不会创建插件路由配置 |
| 换设备后自定义线路或模型没有同步 | 在原设备导出配置，在目标设备导入、预览、替换到编辑区并保存；账号仍通过 Magpie 登录 |

## 开发与验证

```sh
npm test
```

自动化测试使用模拟请求与临时账号，不使用真实 Key 或付费模型，覆盖路由、诊断及配置备份的往返与校验。新增 Gemini/System One 已用 Magpie v0.1.4267 原生插件宿主和本地 HTTP 上游验证目录、SDK 与决策标记、鉴权和主备 ID。原有配置保存、登录、测试返回及导入导出流程此前已通过同版本浏览器验证；Windows 虚拟主机失效场景使用浏览器模拟，未在真实 Windows WebView2 上运行。

| 文件 | 用途 |
| --- | --- |
| `index.mjs` | 供应商配置、登录、目录与余额钩子 |
| `lib/routing.mjs` | 地址解析、账号发现缓存与主备转发 |
| `lib/diagnostics.mjs` | 协议示例、诊断记录与脱敏 |
| `lib/diagnostic-service.mjs` | 本地测试服务与配置页资源 |
| `page/config-transfer.js` | 备份格式、配置校验与导入摘要 |
| `page/` | 配置页、测试页及消息桥接 |
| `test/` | 路由、诊断和配置迁移回归测试 |

## 许可证

MIT
