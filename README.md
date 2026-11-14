# magpie-kunbot

kunbot 的 [magpie](https://usemagpie.ai/docs/zh/plugins) 提供商插件。

使用 API Key 登录，直接读取站点发布的模型目录而非硬编码模型列表，模型选择器会自动显示站点当前提供的模型。当 Key 具备专有模型访问权限（Proprietary Access）时会追加专有模型，并将 Pt 余额作为额度上报。

状态站固定为 `ant.kunbot.org`；登录时可以填 `Request Base URL`，它只重写实际的模型请求，不影响目录、模型列表和余额查询。它可以有三种写法：

| 写法 | 说明 |
| --- | --- |
| 留空 | 每个模型使用目录给它的地址。一条 Key 的多条线路各有各的 Base URL 时用这种（推荐） |
| 一个 URL | 所有模型请求都改发到这个地址，路径保持不变 |
| `线路=URL` 列表 | 只重写列出的线路，其余仍用目录地址。线路名是模型键的第一段（`hikari`、`maid` 等），`proprietary` 是专有模型网关，`*` 是所有未单列线路的默认值 |

| 地址 | 说明 |
| --- | --- |
| `ant.kunbot.org` | 固定状态站：提供模型目录、公告与余额鉴权会话 |
| 目录返回值 | 模型网关：每条线路自己的 Base URL，聊天、图像与私有模型请求都发往对应模型自己的地址 |
| Request Base URL | 可选覆盖：单个 URL 覆盖全部线路，`线路=URL` 只覆盖指定线路，均保留原路径 |

## 功能特性

- **动态读取站点模型目录**：从 `/configs/pi/models.json` 获取所有开源权重模型配置，包括线路 Base URL、协议、上下文大小、输出上限、费用及推理开关。无需硬编码，站点新增线路或调整限制会自动同步。
- **按路线适配推理档位**：根据目录中的 `thinkingLevelMap` 精确提供该线路支持的推理强度（如 `low`、`high`、`max`），避免发送不支持的档位。
- **自动发现图像线路**：读取 `/api/openweight`，把 `label` 为 `Image Generation` 的路由按备注中的 `Supported Model:` 加入图像模型，并声明为只输出图片；magpie 0.1.3423+ 会把它列入图像模型并通过插件的 `fetch` 请求该线路的 `/v1/images/generations`。
- **支持专有模型**：当专有模型开放且 Key 拥有权限时自动加入模型列表；停运时自动回退为纯开源线路。
- **额度展示**：在 `magpie quota` 中显示当前 Key 的 Pt 余额；若 Key 未登记或未开通专有权限会给出明确提示。

插件不会根据站点当前的健康检查状态隐藏任何模型：线路是否可用交由站点自身决定，插件不代为过滤。

图像线路依赖站点继续使用 `Image Generation` 标签和 `Supported Model:` 备注；站点改名或改格式时该线路会暂时不被识别。
如果备注里的模型名被脱敏（例如 `???????-??-Image`），插件无法还原真实 ID，该线路不会生成可用模型。

## 接口与路由

在 magpie 中聚合为一个 `kunbot` 提供商，底层按模型分发到不同端点：

| 模型类型 | 请求地址 | 协议 |
| --- | --- | --- |
| 开源权重模型 | 目录提供的 `<base>/<route>/v1` | OpenAI Chat Completions |
| 图像生成模型 | 路由提供的 `<base>/<route>/v1/images/generations` | OpenAI Images API |
| 专有模型 | 专有模型接口提供的 `base_url` | Anthropic Messages |

聊天与图像模型地址由站点目录和路由列表提供，专有模型地址由专有模型接口提供。

## 一个 Key，多个 Base URL

magpie 选择请求地址的顺序是：

1. `auth.loader` 返回的 `baseURL`；
2. 模型自己的 `provider.api`（`config` 钩子）或 `api.url`（`provider.models` 钩子）；
3. 提供商的 `api`；
4. AI SDK 包自己的默认地址。

所以一个 Key 要对应多个 Base URL，正确做法是让**每个模型带自己的地址**，而不是给账号设一个全局 `baseURL`：

- `config` 钩子把目录里每条线路的 `baseUrl` 写到该线路模型的 `provider: { npm, api }`；
- `provider.models` 钩子把它写成模型级 `api: { id, url, npm }`；
- `auth.loader` 故意不返回 `baseURL`，否则 magpie 会让它覆盖所有模型地址。

目录本身已经是多地址的（`.../hikari/v1`、`.../maid/v1`……），因此一个 Key 只登录一次就能用全部线路；登录时 `Request Base URL` 留空即可。

只有要把部分线路改到代理或镜像时才需要填 `Request Base URL`：单个 URL 覆盖全部线路，`线路=URL` 只覆盖指定线路，`*` 作为未单列线路的默认值。覆盖在 loader 的 `fetch` 里按请求路径的第一段选择，仍然使用同一个 Key，例如：

```text
maid=https://proxy.example/maid, uni=https://proxy.example/uni
```

也可以只写一个地址：

```text
https://proxy.example
```

### 同一服务的镜像分流

如果两个地址是同一套服务的镜像（不是目录里的不同线路），用两个账号：

1. 第一次登录：`Request Base URL` 填主站（或留空用目录地址），`Account name` 填 `primary`，`API Key` 填同一个。
2. 第二次登录：`Request Base URL` 填镜像，`Account name` 填 `mirror`，`API Key` 仍填同一个。
3. 让 magpie 在账号间分流：

```sh
magpie provider set kunbot routing=rotate
```

要按权重就改成 `routing=weight`，要先耗尽主站再切镜像就用 `routing=drain`。模型 ID 仍然只有一套 `kunbot/<route>/<model>`，两个账号会分别显示额度（同一个 Key 的余额会读两次）。

注意 `Request Base URL` 是前缀，会保留目录里的路径：目录线路本身是 `https://anthropic.kunbot.art/<route>/v1`，所以镜像应填 `https://mirror.example`，不要填 `https://mirror.example/v1`，否则会变成 `/v1/<route>/v1/...`。如果镜像只提供裸 `/v1/chat/completions`、没有 `/<route>/v1` 路径，它不能直接复用这个目录，需要单独建模型或提供商，再用 routing group 分流。

## 安装

图像模型需要 magpie `0.1.3423` 或更新版本；更早的版本只按模型名判断图像模型。

通过 GitHub 安装：

```sh
magpie plugin add github:wsyzxjn/magpie-kunbot
```

或从本地克隆安装：

```sh
magpie plugin add ./kunbot-magpie-plugin
```

登录凭据：

```sh
magpie plugin login kunbot
```

先输入 `Request Base URL`（留空使用目录里每条线路自己的地址；也可填 `线路=URL` 只覆盖部分线路。它只影响模型请求），再输入 `Account name`（留空表示第一个账号；镜像分流时给第二个账号起不同名字），最后输入 API Key。

在客户端应用中：打开「插件」，添加该插件，然后在 `kunbot` 提供商行点击登录，按提示填写 Request Base URL、Account name 和 API Key。

## 模型名称规则

开源权重模型采用 `<route>/<model_id>` 格式命名，其中 `route` 为接口路径中的分流标识：

```
kunbot/maid/deepseek-ai/DeepSeek-V4.1-Flash
kunbot/otohime/audnai/Warlock-GLM-5.3-FP8
kunbot/uni/zai-org/GLM-5.3
```

图像模型同样带路由段：

```
kunbot/7sref/MiniMax-H3-Image
```

它由 magpie 的
`/v1/images/generations` 调用。

路由段包含在模型键名中，以避免不同线路提供相同模型 ID 时发生冲突。

专有模型开放时直接使用其自身 ID（无路由段）：

```
kunbot/claude-opus-5
kunbot/gpt-5.6
```

## 数据流与凭据安全性

API Key 存放在 magpie 的 `plugin-auth.json`（权限模式 600）中。

- **模型请求**：带 `Authorization: Bearer <key>` 请求头发送至目录提供的模型网关地址；如果登录时填了 Request Base URL，则按线路（或全部线路）替换请求主机，路径保持不变。
- **余额读取机制**：模型网关未鉴权读取返回 403，查询余额采用与网页端一致的流程：通过 `POST /api/proprietary/key` 向固定状态站 `ant.kunbot.org` 提交 Key 获取 Session Cookie，再读取 `/api/proprietary/access`。因此运行 `magpie quota` 时 Key 会发往状态站，查询结果在本地缓存 30 分钟。专有模型开放时，构建模型列表也要用同一鉴权决定是否列出专有模型，所以模型列表刷新同样会发送 Key（当前站点未开放专有模型，此路径不触发）。开源线路的模型请求本身不经过状态站。

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `index.mjs` | 插件核心实现：提供商配置、登录、请求鉴权、目录解析与额度钩子 |
| `package.json` | 包清单与 magpie 并发配置 |

## 许可证

MIT
