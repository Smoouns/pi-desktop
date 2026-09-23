import type { EvalTask } from "./core/types.js";
import { task as contextTask } from "./context/task.js";
import { task as versioningTask } from "./versioning/task.js";
import { task as toolRecoveryTask } from "./tool-recovery/task.js";
import { task as isolationTask } from "./isolation/task.js";
import { task as typedTask } from "./tool-recovery/typed-task.js";
import { task as longHorizonTask } from "./long-horizon/task.js";

/** Stable public task order: context, versioning, tool recovery, isolation. */
export const tasks: EvalTask[] = [contextTask, versioningTask, toolRecoveryTask, isolationTask, typedTask, longHorizonTask];
