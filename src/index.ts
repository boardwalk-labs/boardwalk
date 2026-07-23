// SPDX-License-Identifier: Apache-2.0

// @boardwalk-labs/engine — the open-source single-node runtime.
//
// Two consumers, one implementation (SPEC §1): embedding hosts construct it in-process
// (construct → runOnce → close), the server binary runs it long-lived (construct → start).

export {
  Engine,
  type EngineOptions,
  type DeployArgs,
  type AuthorizeMcpServerOptions,
} from "./engine.js";
export type { InferenceConfig, ProviderConfig } from "./agent/resolve.js";
export type {
  EventRow,
  RunRow,
  WorkflowRow,
  ArtifactRow,
  RunStatus,
  TriggerKind,
  RunErrorShape,
} from "./store/store.js";
export { EngineError, type EngineErrorCode } from "./errors.js";
export { isTerminal } from "./run/supervisor.js";
export { createEngineServer } from "./server/server.js";
// The built-package loader behind Engine.deployWorkflowDir, for embedders that keep workflow
// packages on disk and want the parsed pieces without deploying.
export { loadWorkflowPackage, type LoadedWorkflowPackage } from "./workflow_package.js";
