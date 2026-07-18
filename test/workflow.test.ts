import { describe, it, expect, beforeEach } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import {
  createDevTeamWorkflow,
  stepIds,
  replyProgressKey,
  abortSignalKey,
  triagePrompt,
  fullPrompt,
  executionPrompt,
  inputBreakdown,
  Attachment,
  HistoryTurn,
  ProjectInstructions,
  DevTeamWorkflow,
  ReplyProgress,
  ReplyProgressSink,
  StepUsage,
  UsageSink,
  usageSinkKey,
  triageShadowKey,
  planReviewKey,
} from '../src/engine/core/workflow';
import { Intent, PlanDecision } from '../src/protocol/types';
import { UsageReporter } from '../src/engine/core/usage';
import { TriageResult } from '../src/engine/core/triage';
import { PartialPlan, PlanProgress, PlanResult } from '../src/engine/core/planner';
import { AnswerProgress } from '../src/engine/core/answerer';
import { ExecutionProgress, ExecutionResult, PartialExecution } from '../src/engine/core/executor';
import { SummaryProgress, SummaryResult, PartialSummary } from '../src/engine/core/summarizer';
import { __reset, __setConfig } from './mocks/vscode';

function fakeTriage(
  impl: (prompt: string, onUsage?: UsageReporter) => Promise<TriageResult>
) {
  return { classify: impl } as any;
}

// createDevTeamWorkflow takes a planner *factory* (its model is sized by
// triage's complexity, known only once the run is under way). The optional
// `onComplexity` hook lets a test observe the tier the workflow built it with.
function fakePlanner(
  impl: (
    prompt: string,
    onPartial?: PlanProgress,
    onUsage?: UsageReporter
  ) => Promise<PlanResult>,
  onComplexity?: (complexity?: string) => void
) {
  return ((complexity?: string) => {
    onComplexity?.(complexity);
    return { plan: impl };
  }) as any;
}

function fakeAnswerer(
  impl: (
    prompt: string,
    onPartial?: AnswerProgress,
    onUsage?: UsageReporter
  ) => Promise<string> = async () => 'the answer'
) {
  return { answer: impl } as any;
}

// createDevTeamWorkflow takes an executor *factory* (its model is sized by the
// request's complexity, known only once the run is under way). The optional
// `onComplexity` hook lets a test observe the tier the workflow built it with.
function fakeExecutor(
  impl: (
    prompt: string,
    onPartial?: ExecutionProgress,
    signal?: AbortSignal,
    onUsage?: UsageReporter
  ) => Promise<ExecutionResult> = async () => anExecution,
  onComplexity?: (complexity?: Intent | string) => void
) {
  return ((complexity?: string) => {
    onComplexity?.(complexity);
    return { execute: impl };
  }) as any;
}

// createDevTeamWorkflow takes a summarizer *factory* (optional). It returns a
// summarizer whose `summarize` the execute step calls after a file-changing run.
function fakeSummarizer(
  impl: (
    prompt: string,
    onPartial?: SummaryProgress,
    onUsage?: UsageReporter
  ) => Promise<SummaryResult> = async () => aSummary
) {
  return (() => ({ summarize: impl })) as any;
}

// createDevTeamWorkflow takes a responder *factory* (optional - combined mode).
// It returns a responder whose `respond` the combined step calls; the impl
// returns the route + answer/plan in one go, the way the real responder does.
function fakeResponder(
  impl: (
    prompt: string,
    onPartial?: (progress: any) => void,
    onUsage?: UsageReporter
  ) => Promise<any>
) {
  return (() => ({ respond: impl })) as any;
}

const aSummary: SummaryResult = {
  whatShips: 'A feature',
  howItsBuilt: 'A small module',
  testsAndDocs: 'New tests',
};

// An execution that actually wrote a file, so the summary gate opens.
const anExecutionWithWrite: ExecutionResult = {
  events: [
    { kind: 'tool', tool: 'write', input: 'a.ts', result: 'Wrote a.ts (5 bytes).' },
    { kind: 'text', text: 'Done.' },
  ],
};

const aPlan: PlanResult = {
  summary: 'Add a feature',
  steps: [{ title: 'Find the file', detail: 'locate it' }],
};

const anExecution: ExecutionResult = {
  events: [
    { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
    { kind: 'text', text: 'Done.' },
  ],
};

async function runWorkflow(workflow: DevTeamWorkflow, prompt: string) {
  const run = await workflow.createRun();
  return run.start({ inputData: { prompt } });
}

describe('inputBreakdown', () => {
  it('estimates each prompt section that is present', () => {
    const breakdown = inputBreakdown(
      {
        prompt: 'do the thing here',
        instructions: { source: 'CLAUDE.md', text: 'always be kind to the user' },
        history: [{ role: 'user', text: 'an earlier question about things' }],
        attachments: [{ label: 'File: a.ts', text: 'const a = 1;' }],
        command: 'fix',
      },
      aPlan
    );
    expect(breakdown.instructions).toBeGreaterThan(0);
    expect(breakdown.history).toBeGreaterThan(0);
    expect(breakdown.preamble).toBeGreaterThan(0); // /fix has a prompt preamble
    expect(breakdown.prompt).toBeGreaterThan(0);
    expect(breakdown.attachments).toBeGreaterThan(0);
    expect(breakdown.plan).toBeGreaterThan(0); // only present when executing
  });

  it('omits absent sections and the plan when not executing', () => {
    expect(inputBreakdown({ prompt: 'hi' })).toEqual({ prompt: expect.any(Number) });
  });
});

describe('dev-team workflow routing', () => {
  it('routes a oneshot request to the answerer and skips planner and executor', async () => {
    let plannerCalled = false;
    let executorCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'simple question' })),
      fakePlanner(async () => {
        plannerCalled = true;
        return aPlan;
      }),
      fakeAnswerer(async () => 'It is 4.'),
      fakeExecutor(async () => {
        executorCalled = true;
        return anExecution;
      })
    );

    const result = await runWorkflow(workflow, 'what is 2+2');

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toEqual({
        intent: 'oneshot',
        reason: 'simple question',
        answer: 'It is 4.',
      });
    }
    expect(plannerCalled).toBe(false);
    expect(executorCalled).toBe(false);
  });

  it('routes a planning request through the planner and the executor', async () => {
    let answererCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        answererCalled = true;
        return 'unused';
      }),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'add a feature');

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('planning');
      expect(result.result.reason).toBe('multi-step');
      expect(result.result.plan).toEqual(aPlan);
      expect(result.result.execution).toEqual(anExecution);
      expect(result.result.answer).toBeUndefined();
    }
    expect(answererCalled).toBe(false);
  });

  it('builds the executor with the complexity triage decided', async () => {
    let builtWith: string | undefined = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', complexity: 'complex', reason: 'hard' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(undefined, (c) => {
        builtWith = c as string | undefined;
      })
    );

    const result = await runWorkflow(workflow, 'fix the race condition');

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.complexity).toBe('complex');
    }
    expect(builtWith).toBe('complex');
  });

  it('hands the original prompt to both the triage agent and the planner', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (p) => {
        seen.triage = p;
        return { intent: 'planning', reason: 'x' };
      }),
      fakePlanner(async (p) => {
        seen.planner = p;
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor()
    );

    await runWorkflow(workflow, 'refactor the module');

    expect(seen.triage).toBe('refactor the module');
    expect(seen.planner).toBe('refactor the module');
  });

  it('hands the executor the prompt plus the drafted plan', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async (p) => {
        seen.executor = p;
        return anExecution;
      })
    );

    await runWorkflow(workflow, 'refactor the module');

    expect(seen.executor).toContain('refactor the module');
    expect(seen.executor).toContain('--- Drafted plan ---');
    expect(seen.executor).toContain('Add a feature');
    expect(seen.executor).toContain('1. Find the file - locate it');
  });

  it('hands the original prompt to the answerer on the oneshot path', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    await runWorkflow(workflow, 'what is a closure');

    expect(seen.answerer).toBe('what is a closure');
  });

  it('gives triage attachment labels only; planner and executor the full text', async () => {
    const attachments: Attachment[] = [
      { label: 'File: src/a.ts', text: 'file body' },
    ];
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (p) => {
        seen.triage = p;
        return { intent: 'planning', reason: 'x' };
      }),
      fakePlanner(async (p) => {
        seen.planner = p;
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor(async (p) => {
        seen.executor = p;
        return anExecution;
      })
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'refactor this', attachments } });

    expect(seen.triage).toContain('refactor this');
    expect(seen.triage).toContain('File: src/a.ts');
    expect(seen.triage).not.toContain('file body');
    expect(seen.planner).toContain('--- Attached context ---');
    expect(seen.planner).toContain('file body');
    expect(seen.executor).toContain('file body');
    expect(seen.executor).toContain('--- Drafted plan ---');
  });

  it('hands the conversation history to triage, planner, and executor', async () => {
    const history: HistoryTurn[] = [
      { role: 'user', text: 'create a calculator' },
      { role: 'assistant', text: 'Created calculator.py.' },
    ];
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (p) => {
        seen.triage = p;
        return { intent: 'planning', reason: 'x' };
      }),
      fakePlanner(async (p) => {
        seen.planner = p;
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor(async (p) => {
        seen.executor = p;
        return anExecution;
      })
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'now rename it', history } });

    for (const prompt of [seen.triage, seen.planner, seen.executor]) {
      expect(prompt).toContain('--- Conversation so far ---');
      expect(prompt).toContain('User: create a calculator');
      expect(prompt).toContain('Assistant: Created calculator.py.');
      expect(prompt).toContain('now rename it');
    }
  });

  it('hands the project instructions to planner and executor, never to triage', async () => {
    const instructions: ProjectInstructions = {
      source: 'CLAUDE.md',
      text: 'Never use en dashes.',
    };
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (p) => {
        seen.triage = p;
        return { intent: 'planning', reason: 'x' };
      }),
      fakePlanner(async (p) => {
        seen.planner = p;
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor(async (p) => {
        seen.executor = p;
        return anExecution;
      })
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'add a feature', instructions } });

    expect(seen.triage).not.toContain('Never use en dashes.');
    for (const prompt of [seen.planner, seen.executor]) {
      expect(prompt).toContain('--- Project instructions (CLAUDE.md) ---');
      expect(prompt).toContain('Never use en dashes.');
    }
  });

  it('hands the project instructions to the answerer on the oneshot path', async () => {
    const instructions: ProjectInstructions = {
      source: 'AGENTS.md',
      text: 'Prefer plain language.',
    };
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'what is this', instructions } });

    expect(seen.answerer).toContain('--- Project instructions (AGENTS.md) ---');
    expect(seen.answerer).toContain('Prefer plain language.');
  });

  it('hands the conversation history to the answerer on the oneshot path', async () => {
    const history: HistoryTurn[] = [
      { role: 'user', text: 'what is a closure' },
      { role: 'assistant', text: 'A closure is a function plus its scope.' },
    ];
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'show an example', history } });

    expect(seen.answerer).toContain('--- Conversation so far ---');
    expect(seen.answerer).toContain('User: what is a closure');
    expect(seen.answerer).toContain('show an example');
  });

  it('gives the answerer the full attachment text on the oneshot path', async () => {
    const attachments: Attachment[] = [
      { label: 'File: src/a.ts', text: 'file body' },
    ];
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'explain this', attachments } });

    expect(seen.answerer).toContain('explain this');
    expect(seen.answerer).toContain('--- Attached context ---');
    expect(seen.answerer).toContain('file body');
  });

  it('emits a step-start event per step so the UI can show progress', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const startedSteps: string[] = [];
    const run = await workflow.createRun();
    const unwatch = run.watch((event) => {
      if (event.type === 'workflow-step-start') {
        startedSteps.push(event.payload.id);
      }
    });
    await run.start({ inputData: { prompt: 'add a feature' } });
    unwatch();

    expect(startedSteps).toContain(stepIds.triage);
    expect(startedSteps).toContain(stepIds.plan);
    expect(startedSteps).toContain(stepIds.execute);
  });

  it('never starts the executor step on the oneshot path', async () => {
    // The UI maps a step start onto a progress label, so an executor step
    // starting on a oneshot run would flash a wrong "Executing…" label.
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const startedSteps: string[] = [];
    const run = await workflow.createRun();
    const unwatch = run.watch((event) => {
      if (event.type === 'workflow-step-start') {
        startedSteps.push(event.payload.id);
      }
    });
    await run.start({ inputData: { prompt: 'what is 2+2' } });
    unwatch();

    expect(startedSteps).toContain(stepIds.answer);
    expect(startedSteps).not.toContain(stepIds.execute);
  });
});

describe('dev-team workflow slash commands', () => {
  it('pins the route of a planning command without calling the triage agent', async () => {
    let triageCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => {
        triageCalled = true;
        return { intent: 'oneshot', reason: 'should not run' };
      }),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { prompt: 'the tests are failing', command: 'fix' },
    });

    expect(triageCalled).toBe(false);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('planning');
      expect(result.result.reason).toBe('Requested via /fix.');
      expect(result.result.execution).toEqual(anExecution);
    }
  });

  it('pins a oneshot command to the answerer', async () => {
    let triageCalled = false;
    let plannerCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => {
        triageCalled = true;
        return { intent: 'planning', reason: 'should not run' };
      }),
      fakePlanner(async () => {
        plannerCalled = true;
        return aPlan;
      }),
      fakeAnswerer(async () => 'an explanation'),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { prompt: 'this function', command: 'explain' },
    });

    expect(triageCalled).toBe(false);
    expect(plannerCalled).toBe(false);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toEqual({
        intent: 'oneshot',
        complexity: 'moderate',
        reason: 'Requested via /explain.',
        answer: 'an explanation',
      });
    }
  });

  it('stops a /plan run after drafting: plan-only reply, executor never starts', async () => {
    let executorCalled = false;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'unused' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async () => {
        executorCalled = true;
        return anExecution;
      })
    );

    const startedSteps: string[] = [];
    const run = await workflow.createRun();
    const unwatch = run.watch((event) => {
      if (event.type === 'workflow-step-start') {
        startedSteps.push(event.payload.id);
      }
    });
    const result = await run.start({
      inputData: { prompt: 'add a feature', command: 'plan' },
    });
    unwatch();

    expect(executorCalled).toBe(false);
    expect(startedSteps).not.toContain(stepIds.execute);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toEqual({
        intent: 'planning',
        complexity: 'moderate',
        reason: 'Requested via /plan.',
        plan: aPlan,
      });
    }
  });

  it('routes an unknown command through triage as a plain prompt', async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (p) => {
        seen.triage = p;
        return { intent: 'oneshot', reason: 'question' };
      }),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { prompt: 'what is 2+2', command: 'frobnicate' },
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.reason).toBe('question');
    }
    // No registered preamble: the agents see the bare prompt.
    expect(seen.triage).toBe('what is 2+2');
    expect(seen.answerer).toBe('what is 2+2');
  });

  it("hands the command's preamble to the planner and executor, after the history", async () => {
    const history: HistoryTurn[] = [{ role: 'user', text: 'earlier turn' }];
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'unused' })),
      fakePlanner(async (p) => {
        seen.planner = p;
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor(async (p) => {
        seen.executor = p;
        return anExecution;
      })
    );

    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'the tests are failing', command: 'fix', history },
    });

    for (const prompt of [seen.planner, seen.executor]) {
      expect(prompt).toContain('/fix');
      expect(prompt).toContain('the tests are failing');
      expect(prompt.indexOf('/fix')).toBeGreaterThan(
        prompt.indexOf('--- End of conversation ---')
      );
      expect(prompt.indexOf('/fix')).toBeLessThan(
        prompt.indexOf('the tests are failing')
      );
    }
  });

  it("hands a oneshot command's preamble to the answerer", async () => {
    const seen: Record<string, string> = {};
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'unused' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (p) => {
        seen.answerer = p;
        return 'ok';
      }),
      fakeExecutor()
    );

    const run = await workflow.createRun();
    await run.start({ inputData: { prompt: 'this module', command: 'review' } });

    expect(seen.answerer).toContain('/review');
    expect(seen.answerer).toContain('this module');
  });

  it('emits no triage usage report when a command pins the route', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (_p, onUsage) => {
        onUsage?.({ model: 'm-triage', inputTokens: 1 });
        return { intent: 'planning', reason: 'unused' };
      }),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const seen: StepUsage[] = [];
    const requestContext = new RequestContext();
    requestContext.set(usageSinkKey, (usage: StepUsage) => seen.push(usage));
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature', command: 'do' },
      requestContext,
    });

    expect(seen.map((u) => u.step)).not.toContain('triage');
  });

  it('streams the pinned decision and the final plan through the sink on /plan', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'unused' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const seen: ReplyProgress[] = [];
    const requestContext = new RequestContext();
    requestContext.set(replyProgressKey, (progress: ReplyProgress) =>
      seen.push(progress)
    );
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature', command: 'plan' },
      requestContext,
    });

    expect(seen[0]).toEqual({
      intent: 'planning',
      complexity: 'moderate',
      reason: 'Requested via /plan.',
    });
  });
});

describe('dev-team workflow plan approval', () => {
  // The gate reads myDevTeam.planApproval live from the vscode config mock;
  // reset it between cases so one case's setting cannot leak into the next.
  beforeEach(() => __reset());

  const complexPlan: PlanResult = {
    summary: 'A big change',
    steps: [{ title: 'Do it', detail: 'carefully' }],
    complexity: 'complex',
  };
  const moderatePlan: PlanResult = { ...complexPlan, complexity: 'moderate' };

  /**
   * Build a planning workflow whose planner returns `plan` and whose reviewer
   * answers from `decisions` in order (repeating the last). Tracks how often the
   * executor and planner ran, the prompts the planner saw, and the reviewer's
   * calls. `start` runs it with the review seam wired (unless `seam: false`).
   */
  function gate(plan: PlanResult) {
    const state = { executor: 0, planner: 0, prompts: [] as string[], reviews: 0 };
    const workflow = (decisions: PlanDecision[]) => {
      let i = 0;
      const review = async () => {
        state.reviews += 1;
        return decisions[Math.min(i++, decisions.length - 1)];
      };
      const wf = createDevTeamWorkflow(
        fakeTriage(async () => ({ intent: 'planning', complexity: 'moderate', reason: 'x' })),
        fakePlanner(async (p) => {
          state.planner += 1;
          state.prompts.push(p);
          return plan;
        }),
        fakeAnswerer(),
        fakeExecutor(async () => {
          state.executor += 1;
          return anExecution;
        })
      );
      return { wf, review };
    };
    const start = async (opts: {
      decisions?: PlanDecision[];
      seam?: boolean;
      command?: string;
    } = {}) => {
      const { wf, review } = workflow(opts.decisions ?? [{ kind: 'approve' }]);
      const requestContext = new RequestContext();
      if (opts.seam !== false) {
        requestContext.set(planReviewKey, review);
      }
      const run = await wf.createRun();
      return run.start({
        inputData: { prompt: 'do the big thing', command: opts.command },
        requestContext,
      });
    };
    return { state, start };
  }

  it('gates a complex plan in auto mode and executes on approve', async () => {
    const g = gate(complexPlan);
    const result = await g.start({ decisions: [{ kind: 'approve' }] });
    expect(g.state.reviews).toBe(1);
    expect(g.state.executor).toBe(1);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.execution).toEqual(anExecution);
    }
  });

  it('delivers the plan only (no execution) when the user cancels at the gate', async () => {
    const g = gate(complexPlan);
    const result = await g.start({ decisions: [{ kind: 'cancel' }] });
    expect(g.state.reviews).toBe(1);
    expect(g.state.executor).toBe(0);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.plan).toEqual(complexPlan);
      expect(result.result.execution).toBeUndefined();
    }
  });

  it('re-plans with the comment on revise, then executes once approved', async () => {
    const g = gate(complexPlan);
    const result = await g.start({
      decisions: [{ kind: 'revise', comment: 'use fewer files' }, { kind: 'approve' }],
    });
    // Planner ran twice (initial + revision); the revision prompt carries the comment.
    expect(g.state.planner).toBe(2);
    expect(g.state.prompts[1]).toContain('use fewer files');
    expect(g.state.prompts[1]).toContain('Plan review');
    expect(g.state.reviews).toBe(2);
    expect(g.state.executor).toBe(1);
    expect(result.status).toBe('success');
  });

  it('does not gate a moderate plan in auto mode', async () => {
    const g = gate(moderatePlan);
    await g.start();
    expect(g.state.reviews).toBe(0);
    expect(g.state.executor).toBe(1);
  });

  it('gates every plan in always mode, even a moderate one', async () => {
    __setConfig('myDevTeam.planApproval', 'always');
    const g = gate(moderatePlan);
    await g.start({ decisions: [{ kind: 'approve' }] });
    expect(g.state.reviews).toBe(1);
    expect(g.state.executor).toBe(1);
  });

  it('never gates in never mode, even a complex plan', async () => {
    __setConfig('myDevTeam.planApproval', 'never');
    const g = gate(complexPlan);
    await g.start();
    expect(g.state.reviews).toBe(0);
    expect(g.state.executor).toBe(1);
  });

  it('does not gate when no review seam is offered, whatever the setting', async () => {
    __setConfig('myDevTeam.planApproval', 'always');
    const g = gate(complexPlan);
    await g.start({ seam: false });
    expect(g.state.reviews).toBe(0);
    expect(g.state.executor).toBe(1);
  });

  it('skips the gate for a plan-only command and never executes', async () => {
    __setConfig('myDevTeam.planApproval', 'always');
    const g = gate(complexPlan);
    const result = await g.start({ command: 'plan' });
    expect(g.state.reviews).toBe(0);
    expect(g.state.executor).toBe(0);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.plan).toEqual(complexPlan);
    }
  });
});

describe('dev-team workflow combined mode', () => {
  beforeEach(() => __reset());

  // A workflow built with a responder factory runs in combined mode: the
  // responder replaces triage + the answerer/planner on the unpinned path. The
  // triage/planner/answerer fakes are still passed (a pinned command uses them),
  // and counters track which actually ran.
  function combined(
    respond: (prompt: string, onPartial?: (p: any) => void) => Promise<any>
  ) {
    const state = { triage: 0, planner: 0, answerer: 0, executor: 0, responder: 0 };
    const wf = createDevTeamWorkflow(
      fakeTriage(async () => {
        state.triage += 1;
        return { intent: 'planning', complexity: 'moderate', reason: 'x' };
      }),
      fakePlanner(async () => {
        state.planner += 1;
        return aPlan;
      }),
      fakeAnswerer(async () => {
        state.answerer += 1;
        return 'pinned answer';
      }),
      fakeExecutor(async () => {
        state.executor += 1;
        return anExecution;
      }),
      undefined,
      fakeResponder(async (p, onPartial) => {
        state.responder += 1;
        return respond(p, onPartial);
      })
    );
    return { state, wf };
  }

  it('answers a oneshot in one responder call, never touching triage or the executor', async () => {
    const { state, wf } = combined(async () => ({
      intent: 'oneshot',
      reason: 'just a question',
      complexity: 'simple',
      answer: 'a closure captures its scope',
    }));
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'what is a closure' } });
    expect(state.responder).toBe(1);
    expect(state.triage).toBe(0);
    expect(state.answerer).toBe(0);
    expect(state.executor).toBe(0);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('oneshot');
      expect(result.result.answer).toBe('a closure captures its scope');
    }
  });

  it('drafts a plan in one responder call and executes it', async () => {
    // The real responder builds a plan carrying its complexity; mirror that.
    const responderPlan: PlanResult = { ...aPlan, complexity: 'moderate' };
    const { state, wf } = combined(async () => ({
      intent: 'planning',
      reason: 'needs a change',
      complexity: 'moderate',
      plan: responderPlan,
    }));
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'refactor the module' } });
    expect(state.responder).toBe(1);
    expect(state.triage).toBe(0);
    expect(state.planner).toBe(0);
    expect(state.executor).toBe(1);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('planning');
      expect(result.result.plan).toEqual(responderPlan);
      expect(result.result.execution).toEqual(anExecution);
    }
  });

  it('hands the responder the full prompt with attachment text', async () => {
    let seen = '';
    const { wf } = combined(async (p) => {
      seen = p;
      return { intent: 'oneshot', reason: 'r', complexity: 'simple', answer: 'ok' };
    });
    const run = await wf.createRun();
    await run.start({
      inputData: {
        prompt: 'explain this',
        attachments: [{ label: 'File: src/a.ts', text: 'file body' }],
      },
    });
    expect(seen).toContain('explain this');
    expect(seen).toContain('--- Attached context ---');
    expect(seen).toContain('file body');
  });

  it('gates a complex plan from the responder and delivers plan-only on cancel', async () => {
    const complexPlan: PlanResult = {
      summary: 'A big change',
      steps: [{ title: 'Do it', detail: 'carefully' }],
      complexity: 'complex',
    };
    const { state, wf } = combined(async () => ({
      intent: 'planning',
      reason: 'big',
      complexity: 'complex',
      plan: complexPlan,
    }));
    const requestContext = new RequestContext();
    requestContext.set(planReviewKey, async () => ({ kind: 'cancel' }) as PlanDecision);
    const run = await wf.createRun();
    const result = await run.start({
      inputData: { prompt: 'do the big thing' },
      requestContext,
    });
    expect(state.executor).toBe(0);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.plan).toEqual(complexPlan);
      expect(result.result.execution).toBeUndefined();
    }
  });

  it('lets a slash command pin the route and use the dedicated agents, not the responder', async () => {
    // /plan pins planning and stops after drafting; in combined mode it must
    // still go through the dedicated planner, leaving the responder unused.
    const { state, wf } = combined(async () => {
      throw new Error('responder must not run for a pinned command');
    });
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'plan it', command: 'plan' } });
    expect(state.responder).toBe(0);
    expect(state.planner).toBe(1);
    expect(state.executor).toBe(0);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.plan).toEqual(aPlan);
    }
  });
});

describe('dev-team workflow direct route', () => {
  beforeEach(() => __reset());

  // Build a workflow whose triage returns the given intent; counters track which
  // agents ran. The executor records the prompt it was briefed with.
  function routed(intent: Intent, opts: { combined?: boolean } = {}) {
    const state = { planner: 0, executor: 0, responder: 0, executorPrompt: '' };
    const triage = fakeTriage(async () => ({ intent, complexity: 'simple', reason: 'tiny' }));
    const planner = fakePlanner(async () => {
      state.planner += 1;
      return aPlan;
    });
    const executor = fakeExecutor(async (p) => {
      state.executor += 1;
      state.executorPrompt = p;
      return anExecution;
    });
    const responder = fakeResponder(async () => {
      state.responder += 1;
      return { intent, reason: 'tiny', complexity: 'simple' };
    });
    const wf = createDevTeamWorkflow(
      triage,
      planner,
      fakeAnswerer(),
      executor,
      undefined,
      opts.combined ? responder : undefined
    );
    return { state, wf };
  }

  it('classifier mode: a direct change skips the planner and executes with no plan', async () => {
    const { state, wf } = routed('direct');
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'bump the timeout to 60' } });
    expect(state.planner).toBe(0);
    expect(state.executor).toBe(1);
    // The executor was briefed without a plan section, with the direct-task note.
    expect(state.executorPrompt).toContain('--- Task ---');
    expect(state.executorPrompt).not.toContain('--- Drafted plan ---');
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('direct');
      expect(result.result.plan).toBeUndefined();
      expect(result.result.execution).toEqual(anExecution);
    }
  });

  it('combined mode: a direct decision from the responder executes with no plan', async () => {
    const { state, wf } = routed('direct', { combined: true });
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'rename tmp to buffer' } });
    expect(state.responder).toBe(1);
    expect(state.planner).toBe(0);
    expect(state.executor).toBe(1);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('direct');
      expect(result.result.plan).toBeUndefined();
      expect(result.result.execution).toEqual(anExecution);
    }
  });

  it('escalates a direct change to planning when planApproval is "always" (with a review seam)', async () => {
    __setConfig('myDevTeam.planApproval', 'always');
    const { state, wf } = routed('direct');
    const requestContext = new RequestContext();
    const reviews: number[] = [];
    requestContext.set(planReviewKey, async () => {
      reviews.push(1);
      return { kind: 'approve' } as PlanDecision;
    });
    const run = await wf.createRun();
    const result = await run.start({
      inputData: { prompt: 'rename tmp to buffer' },
      requestContext,
    });
    // Escalated: a plan was drafted, gated (approved), then executed.
    expect(state.planner).toBe(1);
    expect(reviews).toHaveLength(1);
    expect(state.executor).toBe(1);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('planning');
      expect(result.result.plan).toEqual(aPlan);
    }
  });

  it('does not escalate a direct change when there is no review seam, even on "always"', async () => {
    __setConfig('myDevTeam.planApproval', 'always');
    const { state, wf } = routed('direct');
    const run = await wf.createRun(); // no planReview seam wired
    const result = await run.start({ inputData: { prompt: 'add a gitignore entry' } });
    expect(state.planner).toBe(0);
    expect(state.executor).toBe(1);
    if (result.status === 'success') {
      expect(result.result.intent).toBe('direct');
    }
  });
});

describe('dev-team workflow clarify route', () => {
  beforeEach(() => __reset());

  const aQuestion = {
    question: 'Which database do you mean?',
    options: ['Postgres', 'SQLite'],
    allowOther: true,
  };

  it('classifier mode: a clarify decision ends the run with the questions and no work agent', async () => {
    let answererCalled = false;
    let plannerCalled = false;
    let executorCalled = false;
    const wf = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'clarify', reason: 'ambiguous', questions: [aQuestion] })),
      fakePlanner(async () => {
        plannerCalled = true;
        return aPlan;
      }),
      fakeAnswerer(async () => {
        answererCalled = true;
        return 'unused';
      }),
      fakeExecutor(async () => {
        executorCalled = true;
        return anExecution;
      })
    );
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'migrate the database' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('clarify');
      expect(result.result.questions).toEqual([aQuestion]);
      expect(result.result.plan).toBeUndefined();
      expect(result.result.execution).toBeUndefined();
      expect(result.result.answer).toBeUndefined();
    }
    expect(answererCalled).toBe(false);
    expect(plannerCalled).toBe(false);
    expect(executorCalled).toBe(false);
  });

  it('coerces clarify to a normal answer when myDevTeam.clarify.enabled is off', async () => {
    __setConfig('myDevTeam.clarify.enabled', false);
    let answererCalled = false;
    const wf = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'clarify', reason: 'ambiguous', questions: [aQuestion] })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        answererCalled = true;
        return 'A reasonable answer.';
      }),
      fakeExecutor()
    );
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'migrate the database' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('oneshot');
      expect(result.result.answer).toBe('A reasonable answer.');
      expect(result.result.questions).toBeUndefined();
    }
    expect(answererCalled).toBe(true);
  });

  it('coerces clarify to a normal answer when the model produced no usable question', async () => {
    let answererCalled = false;
    const wf = createDevTeamWorkflow(
      // intent clarify but an empty question list (or all blank) - nothing to ask.
      fakeTriage(async () => ({ intent: 'clarify', reason: 'ambiguous', questions: [] })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        answererCalled = true;
        return 'A reasonable answer.';
      }),
      fakeExecutor()
    );
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'do the thing' } });
    if (result.status === 'success') {
      expect(result.result.intent).toBe('oneshot');
      expect(result.result.answer).toBe('A reasonable answer.');
    }
    expect(answererCalled).toBe(true);
  });

  it('combined mode: a clarify decision from the responder ends with the questions', async () => {
    let answererCalled = false;
    const responder = fakeResponder(async () => ({
      intent: 'clarify',
      reason: 'ambiguous',
      complexity: 'simple',
      questions: [aQuestion],
    }));
    const wf = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'unused' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        answererCalled = true;
        return 'unused';
      }),
      fakeExecutor(),
      undefined,
      responder
    );
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'migrate the database' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.intent).toBe('clarify');
      expect(result.result.questions).toEqual([aQuestion]);
    }
    expect(answererCalled).toBe(false);
  });

  it('combined mode: falls back to the answerer when clarify is off', async () => {
    __setConfig('myDevTeam.clarify.enabled', false);
    let answererCalled = false;
    const responder = fakeResponder(async () => ({
      intent: 'clarify',
      reason: 'ambiguous',
      complexity: 'simple',
      questions: [aQuestion],
    }));
    const wf = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'unused' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        answererCalled = true;
        return 'A reasonable answer.';
      }),
      fakeExecutor(),
      undefined,
      responder
    );
    const run = await wf.createRun();
    const result = await run.start({ inputData: { prompt: 'migrate the database' } });
    if (result.status === 'success') {
      expect(result.result.intent).toBe('oneshot');
      expect(result.result.answer).toBe('A reasonable answer.');
      expect(result.result.questions).toBeUndefined();
    }
    expect(answererCalled).toBe(true);
  });
});

describe('prompt assembly', () => {
  const attachments: Attachment[] = [
    { label: 'File: src/a.ts', text: 'const a = 1;' },
    { label: 'Selection from src/b.ts (line 2)', text: 'line1' },
  ];

  const history: HistoryTurn[] = [
    { role: 'user', text: 'create a calculator' },
    { role: 'assistant', text: 'Created calculator.py with add and subtract.' },
  ];

  it('returns the bare prompt when there are no attachments and no history', () => {
    expect(triagePrompt({ prompt: 'hi' })).toBe('hi');
    expect(fullPrompt({ prompt: 'hi' })).toBe('hi');
    expect(triagePrompt({ prompt: 'hi', attachments: [], history: [] })).toBe('hi');
    expect(fullPrompt({ prompt: 'hi', attachments: [], history: [] })).toBe('hi');
  });

  it('prepends a known command preamble to the full prompt, not the triage prompt', () => {
    const full = fullPrompt({ prompt: 'the tests fail', command: 'fix' });
    expect(full).toContain('/fix');
    expect(full.indexOf('/fix')).toBeLessThan(full.indexOf('the tests fail'));
    // Triage is skipped for a known command, so its prompt never carries the
    // preamble; an unknown command has none to carry.
    expect(triagePrompt({ prompt: 'the tests fail', command: 'fix' })).toBe(
      'the tests fail'
    );
    expect(fullPrompt({ prompt: 'hi', command: 'frobnicate' })).toBe('hi');
  });

  it('keeps the command preamble ahead of the attached context', () => {
    const prompt = fullPrompt({ prompt: 'review this', command: 'review', attachments });
    expect(prompt.indexOf('/review')).toBeLessThan(prompt.indexOf('review this'));
    expect(prompt.indexOf('review this')).toBeLessThan(
      prompt.indexOf('--- Attached context ---')
    );
  });

  it('lists attachment labels without contents for triage', () => {
    const prompt = triagePrompt({ prompt: 'refactor', attachments });
    expect(prompt).toContain('refactor');
    expect(prompt).toContain('File: src/a.ts');
    expect(prompt).toContain('Selection from src/b.ts (line 2)');
    expect(prompt).not.toContain('const a = 1;');
    expect(prompt).not.toContain('line1');
  });

  it('inlines each attachment as a labelled fenced block for the full prompt', () => {
    const prompt = fullPrompt({ prompt: 'refactor', attachments });
    expect(prompt).toContain('refactor');
    expect(prompt).toContain('--- Attached context ---');
    expect(prompt).toContain('File: src/a.ts\n```\nconst a = 1;\n```');
    expect(prompt).toContain('Selection from src/b.ts (line 2)\n```\nline1\n```');
  });

  it('prepends a delimited conversation section to the triage prompt', () => {
    const prompt = triagePrompt({ prompt: 'now rename it', history });
    expect(prompt.startsWith('--- Conversation so far ---\n')).toBe(true);
    expect(prompt).toContain('User: create a calculator');
    expect(prompt).toContain('Assistant: Created calculator.py with add and subtract.');
    // The current request follows the closed-off section.
    expect(prompt.indexOf('now rename it')).toBeGreaterThan(
      prompt.indexOf('--- End of conversation ---')
    );
  });

  it('prepends the conversation section to the full prompt, before the attachments', () => {
    const prompt = fullPrompt({ prompt: 'now rename it', attachments, history });
    expect(prompt.startsWith('--- Conversation so far ---\n')).toBe(true);
    expect(prompt).toContain('User: create a calculator');
    const conversationEnd = prompt.indexOf('--- End of conversation ---');
    expect(prompt.indexOf('now rename it')).toBeGreaterThan(conversationEnd);
    expect(prompt.indexOf('--- Attached context ---')).toBeGreaterThan(
      prompt.indexOf('now rename it')
    );
    expect(prompt).toContain('const a = 1;');
  });

  const instructions: ProjectInstructions = {
    source: 'AGENTS.md',
    text: 'Always run the tests.',
  };

  it('prepends the project instructions to the full prompt, not the triage prompt', () => {
    const full = fullPrompt({ prompt: 'add a feature', instructions });
    expect(full.startsWith('--- Project instructions (AGENTS.md) ---\n')).toBe(true);
    expect(full).toContain('Always run the tests.');
    expect(full).toContain('--- End of project instructions ---');
    // Triage routes oneshot-vs-planning; standing conventions would only
    // crowd a small model's context.
    expect(triagePrompt({ prompt: 'add a feature', instructions })).toBe(
      'add a feature'
    );
  });

  it('keeps the project instructions ahead of the conversation and the prompt', () => {
    const full = fullPrompt({ prompt: 'now rename it', instructions, history });
    expect(full.startsWith('--- Project instructions (AGENTS.md) ---\n')).toBe(true);
    expect(full.indexOf('--- Conversation so far ---')).toBeGreaterThan(
      full.indexOf('--- End of project instructions ---')
    );
    expect(full.indexOf('now rename it')).toBeGreaterThan(
      full.indexOf('--- End of conversation ---')
    );
  });

  it('carries the project instructions into the execution prompt', () => {
    const plan: PlanResult = {
      summary: 'Do it',
      steps: [{ title: 'Edit', detail: 'change it' }],
    };
    const prompt = executionPrompt({ prompt: 'refactor', instructions }, plan);
    expect(prompt).toContain('--- Project instructions (AGENTS.md) ---');
    expect(prompt.indexOf('--- Drafted plan ---')).toBeGreaterThan(
      prompt.indexOf('--- End of project instructions ---')
    );
  });

  it('includes the conversation section in the execution prompt', () => {
    const plan: PlanResult = {
      summary: 'Rename it',
      steps: [{ title: 'Rename', detail: 'rename the file' }],
    };
    const prompt = executionPrompt({ prompt: 'now rename it', history }, plan);
    expect(prompt).toContain('--- Conversation so far ---');
    expect(prompt).toContain('User: create a calculator');
    expect(prompt.indexOf('--- Drafted plan ---')).toBeGreaterThan(
      prompt.indexOf('--- End of conversation ---')
    );
  });

  it('appends the numbered plan of titles and details to the execution prompt', () => {
    const plan: PlanResult = {
      summary: 'Do the work',
      steps: [
        { title: 'Find the file', detail: 'locate it' },
        { title: 'Think', detail: 'reason about it' },
      ],
    };
    const prompt = executionPrompt({ prompt: 'refactor', attachments }, plan);
    expect(prompt).toContain('refactor');
    expect(prompt).toContain('--- Attached context ---');
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toContain('--- Drafted plan ---\nDo the work\n');
    // Steps render as "N. title - detail", with no tool annotation.
    expect(prompt).toContain('1. Find the file - locate it');
    expect(prompt).toContain('2. Think - reason about it');
    expect(prompt).not.toContain('(tool:');
  });

  it('lists the available skills before the plan, and omits the section when there are none', () => {
    const plan: PlanResult = {
      summary: 'Do it',
      steps: [{ title: 'Edit', detail: 'change it' }],
    };
    const withSkills = executionPrompt({ prompt: 'refactor' }, plan, [
      { name: 'demo', description: 'a demo skill' },
    ]);
    expect(withSkills).toContain('--- Available skills ---');
    expect(withSkills).toContain('- "demo": a demo skill');
    expect(withSkills.indexOf('--- Available skills ---')).toBeLessThan(
      withSkills.indexOf('--- Drafted plan ---')
    );
    // No skills: the section is absent entirely.
    expect(executionPrompt({ prompt: 'refactor' }, plan)).not.toContain(
      '--- Available skills ---'
    );
  });
});

describe('dev-team workflow reply progress', () => {
  function sinkContext(sink: ReplyProgressSink) {
    const requestContext = new RequestContext();
    requestContext.set(replyProgressKey, sink);
    return requestContext;
  }

  it('streams the triage decision and every plan snapshot through the sink', async () => {
    const partials: PartialPlan[] = [
      { summary: 'Add' },
      { summary: 'Add a feature', steps: [{ title: 'Find the file' }] },
    ];
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async (_prompt, onPartial) => {
        for (const partial of partials) {
          onPartial?.(partial);
        }
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor(async () => anExecution)
    );

    const seen: ReplyProgress[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext: sinkContext((progress) => seen.push(progress)),
    });

    expect(seen.slice(0, 3)).toEqual([
      { intent: 'planning', reason: 'multi-step' },
      { intent: 'planning', reason: 'multi-step', plan: partials[0] },
      { intent: 'planning', reason: 'multi-step', plan: partials[1] },
    ]);
  });

  it('streams the completed plan and every execution snapshot through the sink', async () => {
    const partials: PartialExecution[] = [
      { events: [{ kind: 'tool', tool: 'search', input: '{"query":"*"}' }] },
      {
        events: [
          { kind: 'tool', tool: 'search', input: '{"query":"*"}', result: 'src/a.ts' },
        ],
      },
    ];
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async (_prompt, onPartial) => {
        for (const partial of partials) {
          onPartial?.(partial);
        }
        return anExecution;
      })
    );

    const seen: ReplyProgress[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext: sinkContext((progress) => seen.push(progress)),
    });

    const base = { intent: 'planning', reason: 'multi-step', plan: aPlan };
    expect(seen.slice(-3)).toEqual([
      base,
      { ...base, execution: partials[0] },
      { ...base, execution: partials[1] },
    ]);
  });

  it('streams the triage decision and every answer snapshot through the sink', async () => {
    const snapshots = ['It', 'It is', 'It is 4.'];
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'simple' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (_prompt, onPartial) => {
        for (const snapshot of snapshots) {
          onPartial?.(snapshot);
        }
        return 'It is 4.';
      }),
      fakeExecutor()
    );

    const seen: ReplyProgress[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'what is 2+2' },
      requestContext: sinkContext((progress) => seen.push(progress)),
    });

    expect(seen).toEqual([
      { intent: 'oneshot', reason: 'simple' },
      { intent: 'oneshot', reason: 'simple', answer: 'It' },
      { intent: 'oneshot', reason: 'simple', answer: 'It is' },
      { intent: 'oneshot', reason: 'simple', answer: 'It is 4.' },
    ]);
  });

  it('hands the planner no callback when no sink was provided', async () => {
    let receivedCallback: PlanProgress | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async (_prompt, onPartial) => {
        receivedCallback = onPartial;
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'add a feature');
    expect(result.status).toBe('success');
    expect(receivedCallback).toBeUndefined();
  });

  it('forwards the request-context abort signal to the executor', async () => {
    let receivedSignal: AbortSignal | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async (_prompt, _onPartial, signal) => {
        receivedSignal = signal;
        return anExecution;
      })
    );

    const controller = new AbortController();
    const requestContext = new RequestContext();
    requestContext.set(abortSignalKey, controller.signal);
    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext,
    });

    expect(result.status).toBe('success');
    expect(receivedSignal).toBe(controller.signal);
  });

  it('hands the executor no callback when no sink was provided', async () => {
    let receivedCallback: ExecutionProgress | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async (_prompt, onPartial) => {
        receivedCallback = onPartial;
        return anExecution;
      })
    );

    const result = await runWorkflow(workflow, 'add a feature');
    expect(result.status).toBe('success');
    expect(receivedCallback).toBeUndefined();
  });

  it('hands the answerer no callback when no sink was provided', async () => {
    let receivedCallback: AnswerProgress | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (_prompt, onPartial) => {
        receivedCallback = onPartial;
        return 'ok';
      }),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'what is 2+2');
    expect(result.status).toBe('success');
    expect(receivedCallback).toBeUndefined();
  });
});

describe('dev-team workflow failures', () => {
  it('fails the run on the triage step when the triage agent throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => {
        throw new Error('connection refused');
      }),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'hi');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('connection refused');
      expect(result.steps[stepIds.triage]?.status).toBe('failed');
    }
  });

  it('fails the run on the plan step when the planner throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'needs steps' })),
      fakePlanner(async () => {
        throw new Error('model not found');
      }),
      fakeAnswerer(),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'do work');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.plan]?.status).toBe('failed');
    }
  });

  it('fails the run on the execute step when the executor throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'needs steps' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async () => {
        throw new Error('model not found');
      })
    );

    const result = await runWorkflow(workflow, 'do work');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.execute]?.status).toBe('failed');
      expect(result.steps[stepIds.plan]?.status).toBe('success');
    }
  });

  it('fails the run on the answer step when the answerer throws', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'simple' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async () => {
        throw new Error('model not found');
      }),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'what is 2+2');

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('model not found');
      expect(result.steps[stepIds.answer]?.status).toBe('failed');
    }
  });
});

describe('dev-team workflow shadow triage', () => {
  function shadowRun(shadowTriage: boolean) {
    let triageCalls = 0;
    let predicted: Intent | undefined;
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => {
        triageCalls += 1;
        return { intent: 'oneshot', reason: 'would oneshot' };
      }),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async () => anExecution)
    );
    const requestContext = new RequestContext();
    requestContext.set(triageShadowKey, (p: Intent) => {
      predicted = p;
    });
    return { workflow, requestContext, getCalls: () => triageCalls, getPredicted: () => predicted };
  }

  it('runs triage on a pinned command, keeps the pin, and reports the prediction', async () => {
    const { workflow, requestContext, getCalls, getPredicted } = shadowRun(true);
    const run = await workflow.createRun();
    // /do pins the planning route; triage predicts oneshot - the pin must win.
    const outcome = await run.start({
      inputData: { prompt: 'add a feature', command: 'do', shadowTriage: true },
      requestContext,
    });
    expect(getCalls()).toBe(1);
    expect(getPredicted()).toBe('oneshot');
    expect(outcome.status).toBe('success');
    expect((outcome as { result: { intent: string } }).result.intent).toBe('planning');
  });

  it('does not run triage on a pinned command when shadow triage is off', async () => {
    const { workflow, requestContext, getCalls, getPredicted } = shadowRun(false);
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature', command: 'do' },
      requestContext,
    });
    expect(getCalls()).toBe(0);
    expect(getPredicted()).toBeUndefined();
  });
});

describe('dev-team workflow usage reporting', () => {
  function usageContext(sink: UsageSink) {
    const requestContext = new RequestContext();
    requestContext.set(usageSinkKey, sink);
    return requestContext;
  }

  it('tags each agent usage report with its protocol step on the planning path', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (_p, onUsage) => {
        onUsage?.({ model: 'm-triage', inputTokens: 1, outputTokens: 2 });
        return { intent: 'planning', reason: 'x' };
      }),
      fakePlanner(async (_p, _onPartial, onUsage) => {
        onUsage?.({ model: 'm-plan', inputTokens: 3, outputTokens: 4 });
        return aPlan;
      }),
      fakeAnswerer(),
      fakeExecutor(async (_p, _onPartial, _signal, onUsage) => {
        onUsage?.({ model: 'm-exec', inputTokens: 5, outputTokens: 6 });
        return anExecution;
      })
    );

    const seen: StepUsage[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'add a feature' },
      requestContext: usageContext((usage) => seen.push(usage)),
    });

    expect(seen.map((u) => u.step)).toEqual(['triage', 'plan', 'execute']);
    // Triage carries no input breakdown (it sees only attachment labels).
    expect(seen[0]).toEqual({ step: 'triage', model: 'm-triage', inputTokens: 1, outputTokens: 2 });
    // The full-prompt steps carry the estimated input split; with only a prompt
    // in the request, the prompt is the one section, and the executor also sees
    // the drafted plan.
    expect(seen[1]).toMatchObject({ step: 'plan', model: 'm-plan', inputTokens: 3, outputTokens: 4 });
    expect(seen[1].inputBreakdown).toEqual({ prompt: expect.any(Number) });
    expect(seen[2]).toMatchObject({ step: 'execute', model: 'm-exec', inputTokens: 5, outputTokens: 6 });
    expect(seen[2].inputBreakdown?.prompt).toBeGreaterThan(0);
    expect(seen[2].inputBreakdown?.plan).toBeGreaterThan(0);
  });

  it('tags the answerer report with the answer step on the oneshot path', async () => {
    const workflow = createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'oneshot', reason: 'x' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(async (_p, _onPartial, onUsage) => {
        onUsage?.({ model: 'm-answer', inputTokens: 7 });
        return 'ok';
      }),
      fakeExecutor()
    );

    const seen: StepUsage[] = [];
    const run = await workflow.createRun();
    await run.start({
      inputData: { prompt: 'what is 2+2' },
      requestContext: usageContext((usage) => seen.push(usage)),
    });

    expect(seen).toEqual([
      { step: 'answer', model: 'm-answer', inputTokens: 7, inputBreakdown: { prompt: expect.any(Number) } },
    ]);
  });

  it('hands the agents no usage reporter when no sink was provided', async () => {
    let received: UsageReporter | undefined | 'unset' = 'unset';
    const workflow = createDevTeamWorkflow(
      fakeTriage(async (_p, onUsage) => {
        received = onUsage;
        return { intent: 'oneshot', reason: 'x' };
      }),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor()
    );

    const result = await runWorkflow(workflow, 'hi');
    expect(result.status).toBe('success');
    expect(received).toBeUndefined();
  });
});

describe('dev-team workflow summary', () => {
  // The setting is read live from the vscode config mock; reset it between
  // tests so a "summary off" case cannot leak into the next.
  beforeEach(() => __reset());

  function planningWith(
    execution: ExecutionResult,
    summarizer?: ReturnType<typeof fakeSummarizer>
  ) {
    return createDevTeamWorkflow(
      fakeTriage(async () => ({ intent: 'planning', reason: 'multi-step' })),
      fakePlanner(async () => aPlan),
      fakeAnswerer(),
      fakeExecutor(async () => execution),
      summarizer
    );
  }

  it('summarizes a file-changing run and attaches the summary to the reply', async () => {
    const result = await runWorkflow(
      planningWith(anExecutionWithWrite, fakeSummarizer()),
      'add a feature'
    );
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.summary).toEqual(aSummary);
    }
  });

  it('skips the summary when the run changed no files', async () => {
    let summarizeCalled = false;
    const summarizer = fakeSummarizer(async () => {
      summarizeCalled = true;
      return aSummary;
    });
    // anExecution only searches and reports - no write/edit.
    const result = await runWorkflow(planningWith(anExecution, summarizer), 'just look');
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.summary).toBeUndefined();
    }
    expect(summarizeCalled).toBe(false);
  });

  it('skips the summary when the setting is off, sparing the model call', async () => {
    __setConfig('myDevTeam.summary.showInChat', false);
    let summarizeCalled = false;
    const summarizer = fakeSummarizer(async () => {
      summarizeCalled = true;
      return aSummary;
    });
    const result = await runWorkflow(planningWith(anExecutionWithWrite, summarizer), 'add it');
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.summary).toBeUndefined();
    }
    expect(summarizeCalled).toBe(false);
  });

  it('produces no summary when no summarizer is wired', async () => {
    const result = await runWorkflow(planningWith(anExecutionWithWrite), 'add a feature');
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.summary).toBeUndefined();
    }
  });

  it('keeps the execution reply when the summarizer throws (best-effort)', async () => {
    const summarizer = fakeSummarizer(async () => {
      throw new Error('summarizer exploded');
    });
    const result = await runWorkflow(planningWith(anExecutionWithWrite, summarizer), 'add it');
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.summary).toBeUndefined();
      expect(result.result.execution).toEqual(anExecutionWithWrite);
    }
  });

  it('streams each summary snapshot through the reply sink', async () => {
    const partials: PartialSummary[] = [
      { whatShips: 'A feature' },
      { whatShips: 'A feature', howItsBuilt: 'A small module' },
    ];
    const summarizer = fakeSummarizer(async (_p, onPartial) => {
      for (const partial of partials) {
        onPartial?.(partial);
      }
      return aSummary;
    });
    const seen: PartialSummary[] = [];
    const requestContext = new RequestContext();
    requestContext.set(replyProgressKey, (progress: ReplyProgress) => {
      if (progress.summary) {
        seen.push(progress.summary);
      }
    });
    const run = await planningWith(anExecutionWithWrite, summarizer).createRun();
    await run.start({ inputData: { prompt: 'add a feature' }, requestContext });
    expect(seen).toEqual(partials);
  });

  it('briefs the summarizer with the plan and the execution transcript', async () => {
    let seenPrompt = '';
    const summarizer = fakeSummarizer(async (prompt) => {
      seenPrompt = prompt;
      return aSummary;
    });
    await runWorkflow(planningWith(anExecutionWithWrite, summarizer), 'add a feature');
    expect(seenPrompt).toContain('--- Drafted plan ---');
    expect(seenPrompt).toContain('Find the file');
    expect(seenPrompt).toContain('--- Execution transcript ---');
    // The write tool call is rendered into the transcript with its result.
    expect(seenPrompt).toContain('write a.ts => Wrote a.ts (5 bytes).');
  });

  it('reports the summary step usage to the usage sink', async () => {
    const summarizer = fakeSummarizer(async (_p, _onPartial, onUsage) => {
      onUsage?.({ model: 'm-summary', inputTokens: 9, outputTokens: 4 });
      return aSummary;
    });
    const seen: StepUsage[] = [];
    const requestContext = new RequestContext();
    requestContext.set(usageSinkKey, (usage: StepUsage) => seen.push(usage));
    const run = await planningWith(anExecutionWithWrite, summarizer).createRun();
    await run.start({ inputData: { prompt: 'add a feature' }, requestContext });
    expect(seen).toContainEqual({
      step: 'summarize',
      model: 'm-summary',
      inputTokens: 9,
      outputTokens: 4,
    });
  });
});
