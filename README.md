# qq-qzone-diary

让小鲸按自己的心情，**随手写一条 QQ 说说**（QQ 空间），不用按时按点。

- 时间随机：活跃时段里按 `150~400` 分钟的随机间隔掷骰子，掷中了才写；
- 字数随机：每次从区间里抽一个目标字数，心情低的时候还会自动变短；
- 人设不变：读的是桥接每轮注入的同一份角色卡 `roles/小鲸.md`；
- 心情是真的：读 `dsh-feiyu-mood` 的 `state.json`（mood / 开心·踏实·甜·心疼·担心·难过·吃醋 / 刚才在想什么）；
- 有素材：读当天和主人的私聊（`qq-bridge` 的 `/api/socialV2/recent`）和共享笔记；
- 配图她自己挑：从表情包图库里给候选（带描述），她自己决定配 0~2 张；
- 不总结：提示词里明确禁掉标题、结尾升华、点题、hashtag、AI 腔；
- **有人评论她的说说，她自己回去**：每 5 分钟左右看一遍，认出是主人还是朋友，按当时的脾气回一句；
  回复是**挂在对方那条评论下面**的（真正的嵌套回复，不是顶层评论）；
- **别人回她评论时，接不接由她自己定**：同一个评论串里可以来回好几轮，模型看上下文自己决定理不理、怎么回；
- **朋友的说说她都会去留一句**（包括主人的说说）：看到好友发了新动态就去评，不再掷骰子；
  后续朋友回她时，接不接、怎么接交给模型判断。

## 它怎么工作

```
到点（随机） → 掷骰子写不写 → 读人设 / 心情 / 当天聊天 / 共享笔记 / 上两条说说
             → 给模型写一篇（第一人称、像随手记）→ 她挑配图
             → POST SnowLuma /send_qzone_msg → 记进 state.json + posts.jsonl

每 5 分钟（活跃时段内）→ get_qzone_msg_list 找有评论的说说
             → get_qzone_msg_detail 读评论（含二级回复），拼出每个「评论串」的上下文
             → 跳过自己的、回过的、太旧的
             → 第一次评论：按概率决定要不要理
             → 别人回她：把整串对话交给模型，她自己决定接/不接、怎么接
             → 等 15~60 秒（像看了一会儿才回）
             → Qzone CGI emotion_cgi_addreply_ugc（挂在被评论的那条下面）
             → 顺手看一眼好友动态 get_qzone_feeds，想留话就 comment_qzone
```

发的是**说说**，不是聊天消息 —— 它不会给主人发 QQ 消息，也不会打扰正在进行的对话。

### 「空间里的她」和「私聊里的她」是同一只

插件每次有动作，都会把这件事合并写进 qq-bridge 的**共享笔记**（一天一条、最多记 5 件事），
`notes-sync` 每 1.5 秒把它同步进 `roles/小鲸.md` 的共享记忆区 —— 桥接每轮重新读角色卡，
所以私聊里的她下一句就知道：

```
10-24 空间：11:49 发了条说说「早上五点半爬起来喊人，六点又喊，…」（配了 2 张图）；
            12:01 <主人昵称> 评论了我的说说「你是一只大肥鱼」；12:02 回了主人的评论「…」
```

角色卡里还有一节 `## 八之二、我的 QQ 空间（这是事实，别否认）`：空间账号 <她的QQ号>、
空间昵称就是她自己；问起时先翻共享记忆，没印象就说细节记不清，但不许否认。

> 之前这块会断，是因为 `notes-sync` 挂了没人管。`watchdog.mjs` 现在每 30 秒心跳里都会
> `ensureSync()` 一次，掉了会自动拉回来。

### 回评论是怎么「回」的

SnowLuma 自带的 `comment_qzone` 只能发**顶层评论**（`emotion_cgi_re_feeds`），
回复不会挂到对方那条评论下面。所以这里的回复走 QQ 空间的 `emotion_cgi_addreply_ugc`：

- 用 SnowLuma 的 `get_credentials` 取 `qzone.qq.com` 的 cookie（含 `p_skey`），
  `g_tk = hash33(p_skey)`（`p_skey` 会转，凭证只缓存 60 秒）；
- `commentId` = 被回复评论的 id，**`commentUin` 必须填被回复评论的作者**（填自己会返回 -10049）；
- 被限流（-10049）时换凭证重试 3 次；仍失败就**这一轮先不发、下一轮再试**（连输 3 轮才退回顶层评论），
  宁可晚一点，也不把回复发到「外面」去。

**多轮对话**：别人在她的评论下面回话时，那一整串（原评论 + 所有回复）会一起交给模型，
输出 `{"reply":true,"text":"…"}` 或 `{"reply":false}` —— 接不接、怎么接都是她自己定，
同一个串里最多来回 6 轮（`maxRepliesPerThread`）。

几个约束（都可配）：一小时最多 10 条、一天最多 20 条、同一条说说下面最多 10 条，
48 小时前的旧评论不再回；第一次评论有 8% 的几率她就懒得理（真人也不会每条都回）。
回复是**公开**的，所以提示词明确禁止把私聊私事、主人的隐私写进去，也不许替主人许诺。

### 评论好友动态

`get_qzone_feeds` 里凡是 `appid=311`（说说）且不是自己的、发布时间在
`minAgeMinutes~maxAgeHours`（默认 20 分钟~24 小时）之间的动态，**她都会去留一句**——
不再掷骰子（`friends.chance` 默认 1）。一轮最多评 `maxPerPoll` 条（默认 3），
一天最多 `maxPerDay` 条（默认 10，正常也到不了）。**主人的说说也会评**
（`friends.commentOwner: true`，想关就改成 false）。想只评某几个人，把 `friends.allowUins`
填上 QQ 号；想排除谁就填 `skipUins`。

她在朋友说说下留过言之后，如果那个朋友回她（评论串里的回复），**不预设规则**：
整串对话交给模型，接不接、怎么接（还是干脆不理）由她自己判断，最多来回 6 轮；
这部分只回看她最近 72 小时留过言的那几条说说。

## 安装后先别急着让它跑

### 先填这几个（源码里故意全部留空，别把你的号提交上去）

| 字段 | 填什么 |
|---|---|
| `sourceKey` | `private:<你自己的 QQ 号>` —— 从你和 Bot 的私聊里取材 |
| `comments.ownerQQ` | 主人的 QQ 号（数字）。也可以不写 config，设环境变量 `QQ_QZONE_OWNER_QQ` |
| `comments.ownerNick` | 主人在 QQ 空间的昵称，用于认出「这人就是主人」 |
| `comments.spaceNick` | 她在 QQ 空间的昵称，用于「这就是我自己」的判定 |
| `rolePath` | 你的角色卡路径，如 `<你的qq-bridge目录>/roles/小鲸.md` |

其余路径同样默认为空，按你自己的安装位置填：
`notesPath` / `spaceFile` / `sessionsPath` / `consoleTokenPath` / `snowlumaConfigDir` / `bridgeConfigPath`。

> 源码里的默认值刻意全部留空 —— 这个仓库不含作者的 QQ 号、昵称或本机路径。
> 你自己的值只写进 `<DSH_HOME>/qq-qzone-diary/config.json`，那份文件不会被提交。

首次启动会在 `<DSH_HOME>/qq-qzone-diary/`（DSH_HOME 默认 `~/.dsh`，可用环境变量 `DSH_HOME` 指定）下生成：

| 文件 | 作用 |
|---|---|
| `config.json` | 配置，改完重启/重载生效 |
| `state.json` | 发过几条、上次时间、下次计划 |
| `posts.jsonl` | 每一条发出去的说说（含 tid、字数、心情） |
| `diary.log` | 运行日志（超过 256KB 自动转存 `.1`） |
| `images/` | 手动图库：往里丢图片，**文件名就是描述**；想写长描述就放同名 `.txt` |

### 试写（不发出去）

把配置改成：

```json
{ "dryRun": true, "runAfterMinutes": 1 }
```

重启/重载后看 `diary.log` 里的 `[dryRun]` 那行 —— 会完整打印这次会发的正文和配图。
满意了改回 `"dryRun": false, "runAfterMinutes": 0`。

## 配置（`config.json`，patch 里的 `config` 会叠在它上面）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `sourceKey` | 空（必填） | 从哪个会话取材，形如 `private:你的QQ号`；说说固定发在 SnowLuma 登录的那个号的空间 |
| `rolePath` | 空（必填） | 人设卡，改一次立刻生效（按 mtime 缓存） |
| `moodPath` | `<DSH_HOME>/feiyu-mood/state.json` | 心情来源 |
| `notesPath` | 空 | 共享笔记 |
| `activeHours` | `["08:30","23:40"]` | 只在这个时段里发 |
| `gapMinutes` | `[150,400]` | 两次之间的随机间隔（分钟） |
| `writeChance` | `0.62` | 到点后真的想写的概率 |
| `dailyMax` | `3` | 一天最多几条 |
| `minGapMinutes` | `90` | 两条之间至少隔多久 |
| `length` | `[70,300]` | 每次随机取的字数区间 |
| `lowMoodShrink` | `0.55` | 心情 ≤40 时字数上限打这个折 |
| `images.enabled` | `true` | 是否让她配图 |
| `images.chance` | `0.8` | 这一条给她图候选的概率（剩下的是纯文字） |
| `images.max` | `2` | 最多配几张 |
| `ugcRight` | `1` | 说说权限：1 公开 / 4 好友 / 9 仅自己 |
| `provider` / `model` | `deepseek-account` / `deepseek-flash` | 写说说用的模型 |
| `temperature` | `0.95` | 高一点，别写成同一篇 |
| `dryRun` | `false` | 只写不发 |
| `runAfterMinutes` | `0` | 启动 N 分钟后试写一条（调试；会跳过概率和每日上限） |
| `comments.enabled` | `true` | 回评论总开关 |
| `comments.pollMinutes` | `5` | 隔多久去看一眼新评论 |
| `comments.replyChance` | `0.92` | **第一次**评论时真的回的几率（别人回她时由模型自己定） |
| `comments.maxReplyAgeHours` | `48` | 超过这么久的评论不再回 |
| `comments.maxRepliesPerHour` / `maxRepliesPerDay` | `10` / `20` | 回复频率上限 |
| `comments.maxRepliesPerPost` | `10` | 同一条说说下面最多回几条 |
| `comments.maxRepliesPerThread` | `6` | 同一个评论串里最多来回几轮 |
| `comments.maxPerPoll` | `2` | 一轮最多回几条 |
| `comments.maxReplyChars` | `70` | 回评字数上限 |
| `comments.ownerQQ` | `0` | 主人的 QQ（他评论时语气会软），也可设环境变量 `QQ_QZONE_OWNER_QQ` |
| `comments.replyDelayMs` | `[15000,60000]` | 回之前先「看一会儿」，别秒回得像脚本 |
| `comments.dryRun` | `false` | 回评只写日志不发出去 |
| `comments.runAfterMinutes` | `0` | 调试：启动 N 分钟后先查一次评论 |
| `friends.enabled` | `true` | 评论好友动态总开关 |
| `friends.chance` | `1` | 留 1 = 看到就去评；设成 0.x 才会掷骰子 |
| `friends.maxPerDay` | `10` | 一天最多评几条 |
| `friends.maxPerPoll` | `3` | 一轮最多评几条（多出来的排下一轮） |
| `friends.minAgeMinutes` / `maxAgeHours` | `20` / `24` | 只评这个时间窗内发的说说 |
| `friends.allowUins` | `[]` | 只评这些人（空 = 所有好友） |
| `friends.skipUins` | `[]` | 永不评论这些人 |
| `friends.commentOwner` | `true` | 要不要也去评论主人的说说 |
| `friends.maxChars` | `50` | 评论字数上限 |
| `friends.delayMs` | `[8000,25000]` | 评论前先「看一会儿」 |
| `friends.dryRun` | `false` | 只写日志不真发 |

## 配图从哪来

1. `images.memeDb` + `memeRoot`：dsh-meme 那套表情包（默认是大肥鱼图库，24 张，带 `caption` 和关键词），
   走 `node:sqlite` 读索引；读不到索引就退回扫目录（目录名当 tag、文件名当描述）。
2. `images.dir`（默认 `<DSH_HOME>/qq-qzone-diary/images`）：自己丢的图片。
   文件名当描述，想写细一点就放同名 `.txt`。

按心情加权抽 10 张候选给模型，她自己挑 0~2 张；挑不到合意的就不配图。

## 边界

- 只在私聊的**素材**上取材，不把聊天内容原文发出去（模型会改写；提示词也要求别复述流水账）。
- 不写性内容、不编造没发生的事（提示词里明确要求「拿不准就写模糊一点」）。
- 回评是公开的：提示词禁止把私聊私事、主人隐私写进回复，也不许替主人许诺。
- 失败不重试轰炸：发不出去就记日志，等下一个随机时间点。

## 卸载

`plugin_manager` 里移除 `qq-qzone-diary` 这个 bundle，或从 profile 的 `package.json`
`dsh.profile.bundles` 里删掉它。

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。

```text
MIT License — Copyright (c) 2026 qq-qzone-diary contributors
任何人可以免费使用、复制、修改、合并、发布、分发、再许可和销售本软件的副本，
唯一条件是保留上述版权声明与许可声明。软件按「原样」提供，不含任何担保。
```

## 免责声明

- 本项目仅供**学习与研究**使用，作者不对任何滥用行为负责。
- 本插件通过自动化方式操作 QQ 空间（发说说、回评论），可能涉及腾讯《QQ 空间服务条款》
  中关于自动化的相关约定 —— 使用即表示你理解并**自行承担**账号被限制、冻结等风险。
- 请勿将本插件用于批量发帖、刷屏、营销等任何形式的垃圾信息行为。
- 你的 QQ 号、cookie 等凭证只保存在本机 `<DSH_HOME>/qq-qzone-diary/config.json`，
  本项目不收集、不上传任何个人信息。
