/**
 * The capability contract: the one mechanism by which an engine asks its client
 * to do something it cannot do itself - run a tool, get a plan approved, check
 * in mid-execution, ask the user a question, or load a skill body. Every such
 * request crosses the same `ClientHost.invoke` seam, named by a `CapabilityName`
 * and carrying plain, wire-serializable data, so the in-process, sidecar, and
 * remote transports all carry it identically and a new capability never needs a
 * new bespoke method, event, or wire message.
 *
 * The static types are recovered on top of that one generic seam by a typed
 * facade: the engine calls `hostFacade(host).reviewPlan(...)` and gets a typed
 * `PlanDecision` back; the client builds its host from typed handlers with
 * `makeClientHost(...)`. The only place the per-capability types are erased is
 * inside those two adapters (and the wire), exactly where a generic dispatch has
 * to.
 *
 * This module imports only the protocol's own data types (and the `ToolHost`
 * the tool capability extends), so it stays editor-free and wire-safe like the
 * rest of `src/protocol/`.
 */
import {
  CheckpointInfo,
  Complexity,
  ContinueDecision,
  Plan,
  PlanDecision,
} from './types';
import { ToolHost } from './toolContract';

/**
 * Every engine->client request, by name, with its payload and result types.
 * The single source of truth for both the typed facade (engine side) and the
 * dispatch table (client side):
 *
 *  - `tool`: execute one tool the *model* called and return the text it sees.
 *    That covers the workspace tools (read/search/run/write/edit), discovered
 *    MCP tools, and the two engine-built model tools `clarify` (ask the user a
 *    focused question or two mid-draft) and `skill` (load a skill's body by
 *    name) - all dispatched by the tool name in the payload, all "args in, text
 *    out", so they share one capability. The model-facing result string for
 *    `clarify`/`skill` is composed on the client (the answers, or the body / a
 *    "no such skill" notice). The two remaining capabilities are the ones the
 *    *workflow* triggers, not the model, and they return structured decisions:
 *  - `reviewPlan`: pause for the user's verdict on a drafted plan.
 *  - `confirmContinue`: at a periodic check-in, ask whether to keep executing.
 */
export interface CapabilityMap {
  tool: { payload: { tool: string; args: unknown }; result: string };
  reviewPlan: { payload: { plan: Plan; complexity: Complexity }; result: PlanDecision };
  confirmContinue: { payload: { info: CheckpointInfo }; result: ContinueDecision };
}

export type CapabilityName = keyof CapabilityMap;
export type CapabilityPayload<K extends CapabilityName> = CapabilityMap[K]['payload'];
export type CapabilityResult<K extends CapabilityName> = CapabilityMap[K]['result'];

/** All capability names, in a stable order. */
export const capabilityNames: readonly CapabilityName[] = [
  'tool',
  'reviewPlan',
  'confirmContinue',
];

/**
 * The single inversion seam the engine reaches the client through. `tools` names
 * the client tools the `tool` capability may dispatch (the run's `offeredTools`),
 * and `capabilities` is the set this client implements - the engine degrades a
 * capability the client does not list (no `reviewPlan` => never gates, no
 * `confirmContinue` => never checks in), so every capability is purely additive.
 * `invoke` runs one request: `args` is the
 * capability's payload, `signal` cancels an in-flight call (only `tool` honours
 * it today), and `correlationId` identifies the owning run so a tool's approval
 * prompt is attributed to the right session.
 *
 * The LocalEngine is handed a host that calls the client's implementations
 * directly; a remote/sidecar engine is handed a proxy that posts an `invoke`
 * message and resolves on the answer - and the engine cannot tell them apart.
 */
export interface ClientHost {
  readonly tools: readonly string[];
  readonly capabilities: readonly CapabilityName[];
  invoke<K extends CapabilityName>(
    capability: K,
    payload: CapabilityPayload<K>,
    signal?: AbortSignal,
    correlationId?: string
  ): Promise<CapabilityResult<K>>;
}

/**
 * The typed handlers a real client supplies to build its host. `executeTool`
 * (and `toolNames`) back the always-present `tool` capability; the rest are
 * optional - an absent handler means the client does not implement that
 * capability, so it is left out of `capabilities` and the engine degrades
 * gracefully. Their signatures are the editor-friendly, per-capability shapes;
 * `makeClientHost` folds them onto the one generic `invoke`.
 */
export interface ClientHandlers {
  toolNames: readonly string[];
  executeTool(
    tool: string,
    args: unknown,
    signal?: AbortSignal,
    correlationId?: string
  ): Promise<string>;
  reviewPlan?(plan: Plan, complexity: Complexity): Promise<PlanDecision>;
  confirmContinue?(info: CheckpointInfo): Promise<ContinueDecision>;
}

/**
 * Build a `ClientHost` from typed handlers: derive the `capabilities` set from
 * which handlers were supplied, and dispatch each `invoke` to the matching one.
 * The per-capability types are erased only here, at the generic dispatch - the
 * casts bridge what TypeScript cannot prove across the indexed payload/result
 * relationship, and the switch arms restore each handler's real shape.
 */
export function makeClientHost(handlers: ClientHandlers): ClientHost {
  const capabilities: CapabilityName[] = ['tool'];
  if (handlers.reviewPlan) {
    capabilities.push('reviewPlan');
  }
  if (handlers.confirmContinue) {
    capabilities.push('confirmContinue');
  }

  function invoke<K extends CapabilityName>(
    capability: K,
    payload: CapabilityPayload<K>,
    signal?: AbortSignal,
    correlationId?: string
  ): Promise<CapabilityResult<K>> {
    type R = Promise<CapabilityResult<K>>;
    switch (capability) {
      case 'tool': {
        const p = payload as CapabilityPayload<'tool'>;
        return handlers.executeTool(p.tool, p.args, signal, correlationId) as R;
      }
      case 'reviewPlan': {
        const p = payload as CapabilityPayload<'reviewPlan'>;
        return handlers.reviewPlan!(p.plan, p.complexity) as R;
      }
      case 'confirmContinue': {
        const p = payload as CapabilityPayload<'confirmContinue'>;
        return handlers.confirmContinue!(p.info) as R;
      }
      default: {
        // Exhaustive: a capability added to the map without an arm is a compile
        // error here (the `never` assignment), so the dispatch cannot drift.
        const exhaustive: never = capability;
        return Promise.reject(
          new Error(`Unknown capability "${String(exhaustive)}".`)
        ) as R;
      }
    }
  }

  return { tools: handlers.toolNames, capabilities, invoke };
}

/**
 * The engine-side typed facade over a `ClientHost`: it restores the
 * per-capability method shapes the engine's callers want (a tool execution that
 * is also a `ToolHost`, plus `reviewPlan`/`confirmContinue`), each a thin typed
 * wrapper over the one generic `invoke`. The facade is a `ToolHost`, so it can be
 * passed straight to the planner/executor where a tool host is expected (their
 * model tools - including the engine-built `clarify` and `skill` - all run
 * through its `execute`). `supports` reports whether the client implements a
 * capability, so the engine can wire a seam only when it can be answered.
 */
export interface HostFacade extends ToolHost {
  supports(capability: CapabilityName): boolean;
  reviewPlan(plan: Plan, complexity: Complexity): Promise<PlanDecision>;
  confirmContinue(info: CheckpointInfo): Promise<ContinueDecision>;
}

export function hostFacade(host: ClientHost): HostFacade {
  return {
    tools: host.tools,
    supports: (capability) => host.capabilities.includes(capability),
    execute: (tool, args, signal, correlationId) =>
      host.invoke('tool', { tool, args }, signal, correlationId),
    reviewPlan: (plan, complexity) => host.invoke('reviewPlan', { plan, complexity }),
    confirmContinue: (info) => host.invoke('confirmContinue', { info }),
  };
}
