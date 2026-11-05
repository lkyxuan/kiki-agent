// Entry point for the background task subprocess: the main program starts it with child_process.fork, one per task. See workerhost.ts and workerchild.ts for details.
import { Agents } from "./agents.js";
import { serve } from "./workerchild.js";

process.title = "Kiki background task";
serve(process, (dataDir, model) => new Agents(dataDir, model));
