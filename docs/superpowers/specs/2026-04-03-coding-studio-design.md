# Coding Studio - Design Spec

> 基于 Anthropic Harness 方法论的可配置编码流水线工具

## 1. 概述

Coding Studio 是一个 CLI harness 工具，借鉴文章 *Harness Design for Long-Running Application Development*，但不把某一代 Anthropic harness 的具体编排方式固化为唯一产品形态。它把 **Planner / Generator / Evaluator / Contract / Runtime / Checkpoint** 视为可组合组件，并允许根据模型能力和任务类型切换流水线模式。

- **Planner**：基于 pi-agent-core，将用户的简短 prompt 扩展为完整产品规格
- **Generator**：固定为 Claude Code CLI（子进程调用），负责编码实现、合同草拟和自检
- **Evaluator**：基于 pi-agent-core，独立评估 Generator 的产出质量
- **Contract Layer**：把高层 `spec` 转成可测试的验收标准，避免 Evaluator 只对抽象规格打分
- **Runtime Layer**：负责安装依赖、启动服务、等待 ready、收集日志、清理进程
- **Checkpoint Layer**：负责 git/artifact 快照、失败恢复和断点续跑
- **流水线模式**：支持 `solo`、`plan-build`、`final-qa`、`iterative-qa`，而不是默认固定三 Agent 多轮循环
- **模型调度**：Planner/Evaluator 的底层模型可独立切换（Anthropic/OpenAI/Google 等）
- **认证体系**：对齐 openclaw 的 auth-profiles 模式，支持多提供商、多 key 轮转

## 2. 架构总览

```
coding-studio (CLI)
│
├── CLI Layer (commander)
│   ├── coding-studio run "prompt"                 ← 按 preset/mode 运行
│   ├── coding-studio run "prompt" --mode solo     ← 单 Agent 基线
│   ├── coding-studio run "prompt" -i              ← interactive，关键节点暂停
│   ├── coding-studio resume                       ← 从 checkpoint 恢复
│   ├── coding-studio setup                        ← 交互式 onboarding（配置 auth）
│   ├── coding-studio models status                ← 检查凭证可用性
│   └── coding-studio models list                  ← 列出可用模型
│
├── Orchestrator                                   ← 核心编排器
│   ├── plan()         → Planner Agent
│   ├── contract()     → Contract handshake
│   ├── build()        → Claude Code subprocess
│   ├── selfReview()   → Generator 自检
│   ├── runtime()      → Runtime Manager
│   ├── eval()         → Evaluator Agent
│   ├── checkpoint()   → Checkpoint Manager
│   └── loop()         → 根据 mode / eval 结果决定继续、通过、回滚或终止
│
├── Agents
│   ├── Planner        (pi-agent-core Agent)
│   ├── Generator      (child_process → claude CLI)
│   └── Evaluator      (pi-agent-core Agent + 可插拔评估策略)
│
├── Runtime & Recovery
│   ├── Runtime Manager     (install / build / start / ready / logs / stop)
│   ├── Checkpoint Manager  (git + artifacts 快照)
│   └── Resume / Retry
│
├── Auth & Provider
│   ├── Auth Profiles (auth-profiles.json)
│   ├── Provider Registry (基于 pi-ai)
│   └── Key Rotation (多 key 自动切换)
│
├── Config
│   └── .coding-studio.yml (项目级配置)
│
├── Artifact Store
│   └── .coding-studio/ (spec / contract / runtime / eval / checkpoint)
│
└── Pipeline Presets & Evaluation Strategies
    ├── solo
    ├── plan-build
    ├── final-qa
    ├── iterative-qa
    ├── code-review
    ├── playwright
    ├── test-runner
    └── composite
```

## 3. 项目结构

```
coding-studio/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── src/
│   ├── cli.ts                         ← CLI 入口
│   ├── orchestrator.ts                ← 编排器：plan → contract → build → runtime → eval → loop
│   │
│   ├── config/
│   │   ├── loader.ts                  ← 加载 .coding-studio.yml，解析 ${ENV_VAR}
│   │   ├── schema.ts                  ← 配置 TypeBox schema + 校验
│   │   └── defaults.ts                ← 默认配置值
│   │
│   ├── auth/
│   │   ├── profiles.ts                ← auth-profiles.json 读写
│   │   ├── setup.ts                   ← 交互式 onboarding 流程
│   │   ├── rotation.ts                ← 多 key 轮转逻辑
│   │   └── types.ts                   ← AuthProfile, KeyRef, TokenRef 类型
│   │
│   ├── providers/
│   │   └── registry.ts                ← 基于 pi-ai 的模型发现 + auth 集成
│   │
│   ├── agents/
│   │   ├── planner.ts                 ← Planner Agent
│   │   ├── generator.ts               ← CC 子进程封装
│   │   └── evaluator.ts               ← Evaluator Agent
│   │
│   ├── contracts/
│   │   ├── manager.ts                 ← 合同草拟 + 审查 + 落盘
│   │   ├── schema.ts                  ← Contract schema + 校验
│   │   └── prompts.ts                 ← 合同生成/审查 prompt
│   │
│   ├── artifacts/
│   │   ├── store.ts                   ← 文件读写 + git 集成
│   │   └── types.ts                   ← Spec, BuildResult, EvalReport 类型
│   │
│   ├── runtime/
│   │   ├── manager.ts                 ← install/build/start/stop/ready
│   │   ├── health.ts                  ← 健康检查
│   │   └── logs.ts                    ← 运行日志采集
│   │
│   ├── checkpoints/
│   │   ├── manager.ts                 ← 保存与恢复 checkpoint
│   │   ├── git.ts                     ← git 快照/回滚集成
│   │   └── types.ts                   ← Checkpoint 元数据
│   │
│   ├── pipeline/
│   │   ├── modes.ts                   ← solo / plan-build / final-qa / iterative-qa
│   │   └── presets.ts                 ← 默认 preset 与模型能力假设
│   │
│   └── strategies/
│       ├── types.ts                   ← EvaluationStrategy 接口
│       ├── code-review.ts             ← 代码审查策略
│       ├── playwright.ts              ← Playwright 端到端测试策略
│       ├── test-runner.ts             ← 运行测试套件策略
│       └── composite.ts               ← 组合策略
│
├── tests/
│   ├── unit/
│   │   ├── config/
│   │   │   ├── loader.test.ts
│   │   │   └── schema.test.ts
│   │   ├── auth/
│   │   │   ├── profiles.test.ts
│   │   │   ├── rotation.test.ts
│   │   │   └── setup.test.ts
│   │   ├── agents/
│   │   │   ├── planner.test.ts
│   │   │   ├── generator.test.ts
│   │   │   └── evaluator.test.ts
│   │   ├── contracts/
│   │   │   ├── manager.test.ts
│   │   │   └── schema.test.ts
│   │   ├── artifacts/
│   │   │   └── store.test.ts
│   │   ├── runtime/
│   │   │   ├── manager.test.ts
│   │   │   └── health.test.ts
│   │   ├── checkpoints/
│   │   │   └── manager.test.ts
│   │   ├── pipeline/
│   │   │   └── modes.test.ts
│   │   ├── strategies/
│   │   │   ├── code-review.test.ts
│   │   │   ├── playwright.test.ts
│   │   │   ├── test-runner.test.ts
│   │   │   └── composite.test.ts
│   │   └── orchestrator.test.ts
│   ├── integration/
│   │   └── pipeline.test.ts           ← 端到端流水线测试（mock LLM）
│   ├── benchmarks/
│   │   └── harness-ablation.test.ts   ← 不同 mode/preset 的效果对比
│   └── fixtures/
│       ├── sample-config.yml
│       ├── sample-spec.md
│       ├── sample-contract.md
│       └── sample-eval-report.json
│
└── docs/
```

## 4. 认证体系（对齐 openclaw）

### 4.1 auth-profiles.json

存储位置：`~/.coding-studio/auth-profiles.json`

```json
{
  "version": 2,
  "profiles": {
    "anthropic:main": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-..."
    },
    "anthropic:backup": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-...backup"
    },
    "openai:main": {
      "type": "api_key",
      "provider": "openai",
      "key": "sk-..."
    },
    "google:main": {
      "type": "api_key",
      "provider": "google",
      "key": "AIza..."
    },
    "anthropic:subscription": {
      "type": "token",
      "provider": "anthropic",
      "token": "...",
      "expires": "2026-05-01T00:00:00Z"
    }
  },
  "order": {
    "anthropic": ["anthropic:main", "anthropic:backup", "anthropic:subscription"],
    "openai": ["openai:main"],
    "google": ["google:main"]
  },
  "lastGood": {
    "anthropic": "anthropic:main",
    "openai": "openai:main"
  }
}
```

### 4.2 凭证解析优先级

每个 provider 的凭证解析按以下顺序（与 openclaw 一致）：

1. `CODING_STUDIO_LIVE_<PROVIDER>_KEY` — 环境变量单次覆盖
2. `.coding-studio.yml` 中 `auth.<provider>.apiKey: ${ENV_VAR}` — 项目级环境变量引用
3. `auth-profiles.json` 中 `order[provider]` 列表 — 按顺序尝试
4. `<PROVIDER>_API_KEY` — 通用环境变量 fallback

### 4.3 Key 轮转

当某个 key 遇到 429/quota-exhausted 错误时：
1. 标记当前 key 为 rate-limited（带冷却时间戳）
2. 按 order 切换到下一个可用 key
3. 更新 `lastGood`
4. 所有 key 都不可用时，等待冷却或报错终止

### 4.4 Generator 与 Claude Code 的凭证衔接

Generator 固定使用 Claude Code CLI，因此需要单独说明凭证注入方式：

1. Orchestrator 在启动 `claude` 子进程前，先解析 `generator.authProfile`
2. 若 profile 为 Anthropic API key，则为子进程注入对应环境变量
3. 若 profile 为 Claude subscription / token，则写入 Claude Code 可识别的临时认证上下文
4. 若 `generator.authProfile` 未设置，则回退到用户本地已有的 Claude Code 登录态
5. 每次 Generator 运行都将选中的 profile 写入 `status.json`，便于审计和重跑

### 4.5 交互式 Setup

```bash
$ coding-studio setup

Welcome to Coding Studio!

? Select a provider to configure: (Use arrow keys)
> Anthropic
  OpenAI
  Google (Gemini)
  Custom (OpenAI-compatible)

? Auth method for Anthropic:
> API Key (paste your key)
  Setup Token (from claude setup-token)
  Environment Variable (reference)

? Paste your Anthropic API key: sk-ant-***

✓ Anthropic key verified (Claude Sonnet 4 responded)
✓ Saved to ~/.coding-studio/auth-profiles.json

? Add another provider? (y/N)

? Verify all providers:
  ✓ anthropic:main — OK (claude-sonnet-4-20250514)
  ✓ openai:main — OK (gpt-5.4)
  ✗ google:main — FAILED (invalid key)

Setup complete! Run `coding-studio run "your prompt"` to start.
```

### 4.6 状态检查

```bash
$ coding-studio models status
Provider     Profile              Type     Status    Last Used
anthropic    anthropic:main       api_key  ✓ OK      2 min ago
anthropic    anthropic:backup     api_key  ✓ OK      never
openai       openai:main          api_key  ✓ OK      5 min ago
google       google:main          api_key  ✗ EXPIRED  1 day ago

$ coding-studio models list
Provider     Model                          Context   Cost (in/out)
anthropic    claude-opus-4-6                1M        $15/$75
anthropic    claude-sonnet-4-20250514       200K      $3/$15
openai       gpt-5.4                        256K      $10/$30
google       gemini-3-flash-preview         1M        $0.15/$0.60
...
```

## 5. 项目配置文件 `.coding-studio.yml`

```yaml
# .coding-studio.yml — 跟着项目走的 Harness 配置
# API keys 通过 auth-profiles.json 或环境变量管理，不写在这里

# === 模型调度 ===
models:
  planner:
    provider: anthropic
    model: claude-sonnet-4-20250514
  generator:
    provider: anthropic
    model: claude-opus-4-6
    authProfile: anthropic:main
  evaluator:
    provider: openai
    model: gpt-5.4

# === Generator (Claude Code) ===
generator:
  cliCommand: claude
  authProfile: anthropic:main     # 未设置时可回退到用户本地 Claude Code 登录态
  allowedTools:
    - Edit
    - Write
    - Bash
    - Read
    - Glob
    - Grep
  mcpServers: []
  maxTurns: 200
  selfReview: true
  checkpoint:
    enabled: true
    strategy: git-commit          # git-commit | diff-snapshot
    everyRound: true

# === Runtime ===
runtime:
  install:
    command: npm install
  build:
    command: npm run build
  start:
    command: npm run dev -- --host 127.0.0.1 --port 5173
    url: http://127.0.0.1:5173
    readyPattern: "Local:"
    timeoutSec: 90
  healthcheck:
    type: http                    # http | tcp | command
    target: /
  captureLogs: true

# === 评估配置 ===
evaluation:
  mode: final-pass               # final-pass | iterative
  strategy: composite            # code-review | playwright | test-runner | composite
  maxRounds: 3

  criteriaProfile: app-default   # app-default | frontend-design | backend-service | cli-tool
  criteria:
    - name: functionality
      weight: 1.0
      description: "核心功能是否正常工作"
    - name: product_depth
      weight: 1.0
      description: "是否真正交付了规格要求的产品深度，而不是 demo/stub"
    - name: code_quality
      weight: 1.0
      description: "关键实现是否清晰、可维护，是否存在明显集成风险"
    - name: design_quality
      weight: 1.25
      description: "视觉设计的连贯性与品质"
    - name: craft
      weight: 1.0
      description: "排版、间距、色彩等技术执行"
    - name: originality
      weight: 1.25
      description: "是否有自主设计决策，避免 AI 模板感"

  passRules:
    overallScore: 7.5            # 最终加权总分
    minCriterionScore: 6.0       # 任何核心维度低于该分即失败
    blockersFail: true           # critical blocker 直接 fail
    requiredCriteria:
      - functionality
      - product_depth
      - code_quality

  playwright:
    baseUrl: "http://127.0.0.1:5173"
    viewport: { width: 1280, height: 720 }

# === Planner 配置 ===
planner:
  ambitious: true
  injectAIFeatures: true
  techPreferences:
    frontend: "React + Vite + TailwindCSS"
    backend: "FastAPI"
    database: "SQLite"

# === 流水线控制 ===
pipeline:
  mode: final-qa                # solo | plan-build | final-qa | iterative-qa
  interactive: false
  artifactsDir: .coding-studio/
  resume: true
  stopOnBlocker: true
  contract:
    enabled: true
    maxRevisions: 2
```

## 6. Agent 间通信协议（Artifact Store）

所有 Agent 间通信通过 `.coding-studio/` 目录下的文件进行。

### 6.1 目录结构

```
.coding-studio/
├── spec.md                    ← Planner 输出的产品规格
├── contract.md                ← 本轮/全局验收合同
├── build-log.md               ← Generator 的构建日志/进度
├── self-review.md             ← Generator 自检结果
├── runtime.json               ← 当前运行时状态、URL、PID、日志路径
├── eval-reports/
│   ├── round-1.json           ← 第1轮 Evaluator 报告
│   ├── round-2.json           ← 第2轮 Evaluator 报告
│   └── round-3.json
├── checkpoints/
│   ├── round-1.json           ← checkpoint 元数据
│   └── round-2.json
└── status.json                ← 当前流水线状态
```

### 6.2 Artifact 类型

**Spec（Planner → Generator）**

Planner 输出 `spec.md`，包含：
- 项目概述与目标用户
- 功能列表（按优先级排序）
- 用户故事或 feature slices
- 视觉设计语言（色彩、排版、布局原则）
- 技术架构建议（高层次，不指定实现细节）
- AI 功能织入建议（如果启用）

**Contract（Generator draft → Evaluator review → Orchestrator）**

`contract.md` 不是重复规格，而是把本轮或整次运行的交付目标压缩成可测试标准：

- scope：本轮要完成的功能切片
- non-goals：明确不在本轮解决的问题
- acceptance criteria：逐条可验证标准
- test plan：Evaluator 应覆盖的关键交互、API、数据状态
- rollback plan：若本轮失败，回退到哪个 checkpoint

在 `iterative-qa` 模式下，Contract 可以是逐轮合同；在 `final-qa` 模式下，Contract 可以是整次运行的全局验收合同。

**EvalReport（Evaluator → Generator/Orchestrator）**

```typescript
interface EvalReport {
  round: number;
  timestamp: string;
  verdict: "pass" | "fail";
  overallScore: number;                // 加权总分 0-10
  contractCoverage: number;            // 合同覆盖率 0-1
  scores: {
    name: string;                      // criteria name
    score: number;                     // 0-10
    weight: number;
    feedback: string;                  // 具体反馈
  }[];
  blockers: {
    severity: "critical" | "major";
    description: string;
    evidence?: string;
  }[];
  bugs: {
    severity: "critical" | "major" | "minor";
    description: string;
    location?: string;                 // 文件:行号
    suggestedFix?: string;
  }[];
  summary: string;                     // 给 Generator 的整体反馈
}
```

**RuntimeState（Runtime Manager → Evaluator/Orchestrator）**

```typescript
interface RuntimeState {
  status: "starting" | "ready" | "failed" | "stopped";
  url?: string;
  pid?: number;
  startedAt?: string;
  healthcheck?: {
    ok: boolean;
    detail?: string;
  };
  logFiles: string[];
}
```

**PipelineStatus（Orchestrator 维护）**

```typescript
interface PipelineStatus {
  phase: "planning" | "contracting" | "building" | "running" | "evaluating" | "completed" | "failed";
  mode: "solo" | "plan-build" | "final-qa" | "iterative-qa";
  currentRound: number;
  maxRounds: number;
  activeCheckpoint?: string;
  generatorProfile?: string;
  history: {
    round: number;
    buildDuration: number;             // 秒
    runtimeDuration: number;
    evalDuration: number;
    score: number;
    verdict: "pass" | "fail";
  }[];
}
```

## 7. 核心模块设计

### 7.1 Orchestrator

编排器控制整个流水线的生命周期：

下图描述的是 `iterative-qa` 的完整路径；`solo`、`plan-build`、`final-qa` 会在此基础上裁剪步骤。

```
Start
  │
  ▼
[Plan] ──spec.md──→ (interactive? 暂停等确认)
  │
  ▼
[Contract] ──contract.md──→ (interactive? 暂停等确认)
  │
  ▼
[Build Round 1] ──CC 子进程──→ 代码产出
  │
  ▼
[Self Review] ──self-review.md──→ [Checkpoint]
  │
  ▼
[Runtime Start] ──runtime.json──→ ready?
  │
  ▼
[Eval Round 1] ──eval report──→ verdict?
  │                                │
  │  FAIL (blocker / threshold)    │ PASS
  │  且 round < maxRounds          │
  ▼                                ▼
[Build Round 2]                  Done ✓
  │   (带上 contract + eval feedback)
  ...循环...
  │
  ▼ (round >= maxRounds)
Done (best effort) ⚠
```

**关键行为**：
- `--interactive` 模式下，在 Plan 完成后、Contract 审核后、每轮 Eval 完成后暂停等用户确认
- 每轮 Build 会把 `spec.md`、`contract.md`、上一轮 `eval report`、最近 checkpoint 摘要作为上下文传给 CC
- Runtime Manager 对启动、ready、失败日志、端口冲突、进程清理负责，Evaluator 不假设服务已在外部准备好
- 如果出现 critical blocker 且 `stopOnBlocker: true`，可直接终止或回滚到上一个 checkpoint
- 如果达到 `maxRounds` 仍未 pass，输出 best effort 结果、所有 eval 报告和最近一次 checkpoint

### 7.2 Planner Agent

```typescript
// 伪代码
const planner = new Agent({
  initialState: {
    model: getModelFromConfig(config.models.planner),
    systemPrompt: buildPlannerPrompt(config.planner),
    tools: [
      readFileTool,       // 读取项目现有文件
      globTool,           // 搜索项目结构
    ],
  },
});

const spec = await planner.prompt(userPrompt);
writeArtifact('.coding-studio/spec.md', spec);
```

**System Prompt 要点**：
- 你是一个产品规划师，将简短的 prompt 扩展为完整的产品规格
- 要雄心勃勃（ambitious），主动扩展功能范围
- 聚焦产品上下文和高层技术设计，不指定细粒度实现
- 如果 `injectAIFeatures: true`，主动寻找织入 AI 功能的机会
- 将 `techPreferences` 视为偏好，而不是必须逐字执行的实现约束
- 输出包含：项目概述、功能列表、feature slices、视觉设计语言、技术架构建议

### 7.3 Contract Manager

Contract Manager 解决的是 harness 里的关键桥梁问题：`spec` 很高层，但 Evaluator 需要可验证标准。

工作方式：

1. Generator 基于 `spec.md` 和当前仓库状态草拟 `contract.md`
2. Evaluator 审查合同是否可测试、是否遗漏关键验收点
3. 如果合同不充分，Orchestrator 允许有限次修订
4. 合同冻结后，Build/Eval 都以同一份合同为准

```typescript
const draft = await generator.draftContract(spec, repoState);
const review = await evaluator.reviewContract(spec, draft);

if (!review.approved) {
  const revised = await generator.reviseContract(draft, review.feedback);
  writeArtifact(".coding-studio/contract.md", revised);
} else {
  writeArtifact(".coding-studio/contract.md", draft);
}
```

### 7.4 Generator（CC 子进程）

```typescript
// 伪代码
async function build(
  spec: string,
  contract: string,
  checkpoint?: Checkpoint,
  evalFeedback?: EvalReport
): Promise<void> {
  const prompt = buildGeneratorPrompt(spec, contract, checkpoint, evalFeedback, config);
  const env = resolveGeneratorEnv(config.generator.authProfile);

  const cc = spawn('claude', [
    '-p', prompt,
    '--allowedTools', config.generator.allowedTools.join(','),
    '--max-turns', String(config.generator.maxTurns),
    '--output-format', 'stream-json',
  ], { env });

  // 流式输出 CC 的进度
  cc.stdout.on('data', (chunk) => { /* 解析并显示进度 */ });

  await waitForExit(cc);
}
```

**Prompt 构建**：
- 第一轮：传入 `spec.md` + `contract.md` + 技术栈偏好 + "按照合同交付，不要只做 demo"
- 后续轮：传入 `spec.md` + `contract.md` + 上一轮 `eval report` + 最近 checkpoint 摘要 + "根据评估反馈修复以下问题：..."
- 每轮结束后，若 `selfReview: true`，要求 Generator 写出 `self-review.md`，先过滤明显问题再进入外部 QA

### 7.5 Runtime Manager

Runtime Manager 是 `playwright` / `composite` 策略的前置条件，不能假设应用已经在外部跑好。

职责：

- 执行依赖安装、构建和启动命令
- 等待 ready pattern 或健康检查通过
- 记录 URL、PID、日志路径到 `runtime.json`
- 在评估后清理进程，避免端口泄漏
- 在失败时附带最后 N 行运行日志给 Evaluator 和用户

```typescript
const runtime = new RuntimeManager(config.runtime);
const state = await runtime.start();
writeArtifact(".coding-studio/runtime.json", state);
```

### 7.6 Evaluator Agent

```typescript
// 伪代码
const evaluator = new Agent({
  initialState: {
    model: getModelFromConfig(config.models.evaluator),
    systemPrompt: buildEvaluatorPrompt(config.evaluation),
    tools: [
      ...getStrategyTools(config.evaluation.strategy),  // 策略决定工具集
      readFileTool,
      globTool,
      grepTool,
    ],
  },
});

const report = await evaluator.prompt(
  `评估项目。规格：${spec}\n合同：${contract}\n运行时：${runtimeState}\n评分标准：${criteria}`
);
writeArtifact(`.coding-studio/eval-reports/round-${round}.json`, report);
```

**System Prompt 要点**：
- 你是一个严格的 QA 工程师，独立评估代码产出
- 不要对 LLM 生成的内容手下留情
- 优先依据 `contract.md` 判断是否交付，而不是只对抽象 spec 做主观打分
- 按每个评分维度独立打分（0-10），给出具体反馈
- 列出所有发现的 bug，包含严重程度、位置、建议修复
- 若发现 critical blocker，直接标记失败并提供证据
- 明确区分 stub/demo 与真实可用功能

### 7.7 评估策略

```typescript
interface EvaluationStrategy {
  name: string;
  // 返回该策略需要注入给 Evaluator 的工具集
  getTools(config: EvaluationConfig): AgentTool[];
  // 返回该策略的额外 system prompt 片段
  getPromptFragment(config: EvaluationConfig): string;
}
```

| 策略 | 工具 | 适用场景 |
|------|------|---------|
| `code-review` | readFile, glob, grep | 纯后端、库、CLI 工具 |
| `playwright` | playwright MCP tools | 前端/全栈应用 |
| `test-runner` | bash (npm test) | 有测试套件的项目 |
| `composite` | 以上组合 | 全栈 + 测试 + 视觉 |

判定规则不是单纯 `overallScore >= threshold`，而是三层组合：

1. blocker gate：存在 `critical` blocker 则直接 fail
2. criterion gate：`requiredCriteria` 中任一维度低于 `minCriterionScore` 则 fail
3. aggregate gate：通过前两层后，再检查 `overallScore`

这样可以避免“设计分很高，但功能硬伤被均值冲掉”的假阳性。

### 7.8 Pipeline Modes 与 Presets

`Harness` 里的每个组件都代表一个关于模型能力边界的假设，因此产品不能把某种 mode 固化为唯一正确答案。

| Mode | 说明 | 适用场景 |
|------|------|---------|
| `solo` | 仅 Generator，作为成本和效果基线 | 快速原型、基线对比 |
| `plan-build` | Planner + Generator，无 QA | 能力较强模型、低风险任务 |
| `final-qa` | Planner + Generator + 最终一次 QA | 默认推荐模式 |
| `iterative-qa` | Planner + Contract + 多轮 Build/QA | 高风险、复杂全栈任务 |

后续每次新增 preset 或默认改动，都要通过 benchmark/ablation 证明收益，而不是只凭直觉增加 harness 复杂度。

## 8. 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript (ESM) |
| 运行时 | Node.js >= 20 |
| LLM 层 | @mariozechner/pi-ai |
| Agent 层 | @mariozechner/pi-agent-core |
| CLI | commander |
| 配置 | YAML (yaml 包) + TypeBox schema 校验 |
| 测试 | Vitest |
| 子进程 | child_process (Node built-in) |
| 交互式 setup | @inquirer/prompts |

## 9. 依赖清单

```json
{
  "dependencies": {
    "@mariozechner/pi-ai": "latest",
    "@mariozechner/pi-agent-core": "latest",
    "commander": "^13.0.0",
    "yaml": "^2.7.0",
    "@sinclair/typebox": "^0.34.0",
    "@inquirer/prompts": "^7.0.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

## 10. 开发方法论

本项目自身的开发也遵循 Harness 模式 + TDD：

1. **每个模块**：先写测试 → 再写实现 → 跑测试通过 → code review
2. **实现顺序**（由内到外）：
   - Phase 1：基础设施（config schema/loader, auth profiles, artifact types）
   - Phase 2：执行基础设施（contract manager, runtime manager, checkpoint manager）
   - Phase 3：Agent 层（planner, generator subprocess, evaluator）
   - Phase 4：编排层（pipeline modes, orchestrator loop, resume/retry）
   - Phase 5：CLI 层（commands, interactive mode）
   - Phase 6：评估策略（code-review, playwright, test-runner, composite）
3. **每个 Phase 完成后**：运行全量测试 + 自检
4. **Harness 调优方式**：遵循消融实验思路。默认先做最简单可行模式，再逐个增加 `Planner`、`Contract`、`Runtime QA`、`Iterative QA`，记录质量/成本/时延变化

## 11. Benchmark 与 Ablation 要求

为了避免把过时的模型补丁永久产品化，需要内建 benchmark 套件：

- 基准任务至少覆盖：前端页面、全栈 CRUD、CLI/库 三类任务
- 每个基准任务至少跑 `solo`、`plan-build`、`final-qa` 三种模式
- 记录指标：成功率、critical blocker 漏检率、wall-clock、token/cost、恢复成功率
- 新默认 preset 生效前，必须证明相对当前默认值在至少一个核心指标上显著更优，且没有明显恶化其他指标

## 12. 成功标准

- [ ] `coding-studio setup` 可以交互式配置多提供商凭证
- [ ] `coding-studio models status` 可以检查所有凭证状态
- [ ] `coding-studio run "Build a todo app"` 可以跑完完整的 `Plan → Contract → Build → Runtime → Eval` 流水线
- [ ] `coding-studio run "..." -i` 可以在 Plan、Contract、Eval 后暂停等用户确认
- [ ] `coding-studio resume` 可以从最近 checkpoint 恢复
- [ ] Runtime Manager 可以启动本地服务、等待 ready、收集日志并清理进程
- [ ] 评估策略和 pipeline mode 可通过 `.coding-studio.yml` 切换
- [ ] Planner/Evaluator 的模型可独立配置为不同提供商
- [ ] Generator 可以通过 `authProfile` 解析并注入 Claude Code 凭证
- [ ] 多 key 轮转在 rate limit 时自动切换
- [ ] pass/fail 采用 blocker + 分维阈值 + 总分的组合规则
- [ ] benchmark 套件可以输出不同 mode/preset 的对比报告
- [ ] 所有核心模块有单元测试覆盖
