# dsh-auto-scheduler 设计规格（DESIGN）

DSH 定时自动工作插件：用户在侧边栏填写工作目标与工作时间，到点 DSH 自动新建 Web GUI 会话并开始工作，到停止时间中断 agent 并停止会话（会话保留可回看）。

## 1. 关键决策（与用户确认）

| 决策点 | 选择 |
| --- | --- |
| 调度位置 | Host 端常驻（dsh web 宿主进程内 setInterval，页面关掉也准点触发） |
| 开始工作 | 通过宿主 apiProxy 新建会话（与 Web GUI 同一路径，会话在会话列表可见） |
| 停止工作 | sessions.cancel 中断当前回合并停止会话（会话保留） |
| 静默模式 | danger-full-access + 禁用 ask_user_question + 静默 persona（不提问、完成前不停） |
| 默认模式 | 不指定预设、不动权限、允许提问，一切保留部署默认 |
| 谷峰预设 | 快速填充：北京 12:00-14:00、18:00-次日 9:00（UTC+8），按用户系统时区换算显示 |
| 时区 | UI 输入/显示用用户系统时区（datetime-local），保存时转为 UTC ISO 字符串；调度在 host 用 UTC 毫秒比较 |
| 仓库 | github.com/Cheng-xiu/dsh-auto-scheduler |

## 2. 架构

- 单包双面插件（参考 @linxin666/dsh-liangshen 与 dsh-web-ui 全家桶）：
  - main: lib/index.js（host 端 cordis 插件：定时器 + /api 路由 + 静默预设同步）
  - exports[./client]: lib/client.js（浏览器端 __ModuleLoader__ bundle：侧边栏入口 + 面板）
  - dsh.bundle.patch: cordis.patch.yml（把插件行插入 profile roster）
  - dsh.client = { platform: web, inject: [@deepseek-ai/dsh-client-runtime] }
- 零依赖、零构建脚本（预构建产物直接提交），规避 pnpm11 strictDepBuilds / 本机无 VS 工具链两个坑。

## 3. 数据模型（host 持久化）

文件：DSH_HOME/dsh-auto-scheduler.json（DSH_HOME 缺失时回退 ~/.dsh）。

{ version: 1, schedules: [ {
  id, goal(任务目标文本), mode(silent|default),
  startAtUtc(ISO UTC), stopAtUtc(ISO UTC, 须晚于 startAtUtc, 可跨午夜),
  repeat(once|daily, daily 按 startAtUtc 的 UTC 时刻每天触发),
  enabled, clientTimeZone(客户端上报, prompt 时透传),
  status(idle|running|stopped|missed|error),
  sessionId(最近一次执行创建的会话), lastRunAt(本次执行开始时刻),
  lastFiredAt(已触发的 occurrence 起点, 防重复触发), lastError, createdAt, updatedAt
} ] }

停止时间 = lastRunAt + (stopAtUtc - startAtUtc) 时长。

## 4. REST API（host 路由 /api/dsh-auto-scheduler/*）

全部走 ctx.webServer.register({ kind: exact, path, handler })（参考 dsh-ssh）：

- GET  /api/dsh-auto-scheduler/health -> { ok, version, nowUtc, silentPresetReady, scheduleCount }
- GET  /api/dsh-auto-scheduler/schedules -> { ok, nowUtc, schedules:[含 nextRunAtUtc] }
- POST /api/dsh-auto-scheduler/schedules -> upsert（带 id 更新、不带新建；校验 goal/mode/时间/repeat）
- POST /api/dsh-auto-scheduler/delete -> { id }
- POST /api/dsh-auto-scheduler/toggle -> { id, enabled }
- POST /api/dsh-auto-scheduler/run-now -> { id }（立即执行，停止时间 = now + 原时长）

鉴权（guard）：loopback（复刻 dsh-ssh 的 isLoopbackRequest）或 Host 属于 ctx.get('connection').trustedHosts（cloudflared 隧道域名会被 --trusted-host 放入），其余 403。手机经隧道也能打开面板，同时不向陌生来源暴露调度控制。

## 5. 调度语义（tick = 20s）

- occurrence 计算：
  - once：startAtUtc 到达且未过 stopAtUtc 时触发；超过 stopAtUtc 未触发则置 missed。
  - daily：每天 UTC 时刻触发；跨午夜窗口用 start-1day/start/start+1day 三个候选点判断。
- 触发（fire）：sessions.create（silent 传 agentPreset=dsh-auto-scheduler-silent，default 不传）-> silent 时 ctx.permissionPresets.set(session, danger-full-access) -> sessions.rename 标题「[自动] 目标前缀」-> sessions.prompt(queue, goal, clientTimeZone)。成功记录 sessionId/lastRunAt/lastFiredAt，status=running；失败 status=error 并在窗口内每 tick 重试。
- 停止：status=running 且 now >= lastRunAt + 时长 -> sessions.cancel(sessionId)，status=stopped。
- 错过策略：dsh web 未运行期间到期 -> 直接跳过（once->missed，daily->等次日）；不做补跑。
- 重启对账：启动时 status=running 的旧记录置为 stopped（旧 agent 随进程消失，会话本体仍保留）。

## 6. 静默模式实现

- 插件自带 agent preset 目录 presets/dsh-auto-scheduler-silent/（agent.cordis.yml + preset.yml），启动时同步到 ~/.dsh/.agent-presets/dsh-auto-scheduler-silent/（字节比对）；roster 每次 list 都重读根目录，无需额外注册。
- preset = 官方 standard 预设整份复刻 + 两处修改：
  1. persona 追加静默指令（不问用户、独立决策、连续工作直到完成、失败自愈、完成后总结、可被外部停止）；
  2. tool-ask-user 行加 disabled: true（移除提问工具）。
- 权限：会话创建后 permissionPresets.set(session, danger-full-access)（sandbox danger-full-access + approval/policy never -> 不弹批准）。
- 默认模式：不传 agentPreset、不 set 权限、不发额外指令 = 一切保留默认。

## 7. 客户端 UI（侧边栏面板）

- 侧边栏入口按钮「自动工作」（DOM 注入 + MutationObserver 自愈，复刻 dsh-task-board 的 sidebarRoot/placeEntry，data 属性 data-dsh-autosched-entry）。
- 右侧抽屉面板：
  - 表单：工作目标(textarea)、模式(默认/静默 radio)、开始时间、结束时间(datetime-local 本机时区)、重复(仅一次/每天)、谷峰预设两个快速填充按钮；
  - 谷峰预设（北京时间 UTC+8）：计算下一次窗口填入开始/结束；若当前正处于窗口内则以当前时刻为开始、窗口结束为结束；
  - 列表：目标、模式徽标、本机时区开始/停止、下次执行倒计时、状态、启用开关、立即执行、删除；
  - 顶部注明：时间按本机时区显示（保存为 UTC）；谷峰时段为北京时间已按本机时区换算。
- 轮询：30s 拉取 schedules 刷新。

## 8. 安全与限制

- 静默模式 = 无人值守全权限执行，风险高：guard 仅放行 loopback 与 --trusted-host；面板文案明示风险。
- 定时器在浏览器不可见时依旧触发（host 端）；但 dsh web 进程必须运行，否则错过即跳过。
- 客户端插件变更需重启 dsh web 生效（bundle 注入发生在启动时）。
- 依赖服务：apiProxy / permissionPresets / agentPresets / webServer / systemPrompt（web profile 已全部具备）。

## 9. 发布与安装

- 预构建提交（无 build scripts）：pnpm11 strictDepBuilds 不会拦截安装。
- 发布 github:Cheng-xiu/dsh-auto-scheduler + tag v0.1.0 + topic dsh-plugin。
- 安装：dsh plugin --profile web add github:Cheng-xiu/dsh-auto-scheduler#v0.1.0，然后重启 dsh web。
